/**
 * ChatStore — the PostgreSQL adapter. The record JSONB is the authoritative
 * ChatRecord (the fs adapter's one-file-per-chat shape); the lightweight
 * columns are its list projection so GET /api/chats never drags megabytes of
 * transcript (or base64 snapshots) out of the database.
 *
 * Ownership is resolved per call through pgOwner(), exactly as the fs adapter
 * resolves ownerPaths(): withOwner enters the scope at the request boundary.
 * Every mutating read is SELECT ... FOR UPDATE inside one transaction so a
 * concurrent worker write and turn write can never clobber each other's
 * fields — the same discipline the synchronous read-modify-write gave us on
 * the filesystem.
 */

import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { emit } from "../../core/events.ts";
import type { BlobStore, ChatStore } from "../../core/ports.ts";
import type {
	ChatRecord,
	ChatSettings,
	ChatSummary,
	ExtractionRunUsage,
	ImageSnapshot,
	PlanTree,
	SideChatThread,
	TurnUsage,
} from "../../core/contracts.ts";
import { CURRENT_CHAT_VERSION } from "../../core/contracts.ts";
import type { LhMessage } from "../../core/native-messages.ts";
import { activeProblemOf, danglingQuestionOf } from "../../core/native-messages.ts";
import { phaseAt3Lh, type Phase3 } from "../../core/phases.ts";
import { pgOwner } from "./owner.ts";
import { extForMime, ownerBlobKey } from "../blobs-key.ts";

interface ChatMetaRow {
	id: string;
	title: string;
	kind: string;
	created_at: Date | string;
	updated_at: Date | string;
	version: number;
	message_count: number;
	phase: string;
	pending_question: boolean;
	pending_problem: boolean;
}

interface ChatFullRow extends Partial<ChatMetaRow> {
	record: ChatRecord | string;
}

interface SnapshotRow {
	snapshot_id: string;
	mime_type: string;
	/** Legacy inline base64. NULL once offloaded to the blob store. */
	data: string | null;
	blob_key: string | null;
	width: number;
	height: number;
}

export interface PostgresChatStoreOptions {
	blobStore?: BlobStore;
	/** When false (the default), snapshots keep the inline `data` insert (PR 5 behavior). */
	offloadSnapshots?: boolean;
}

/** pg parses JSONB into objects; a driver/mock returning text still works. */
function parseRecord(value: unknown): ChatRecord | null {
	if (typeof value === "string") {
		try { return JSON.parse(value) as ChatRecord; } catch { return null; }
	}
	return value && typeof value === "object" ? (value as ChatRecord) : null;
}

function iso(value: Date | string): string {
	return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** The summary columns are DERIVED from the same native messages the fs
 *  adapter reads (core/phases.ts + core/native-messages.ts), never sniffed
 *  from a client payload. */
function summaryOf(record: ChatRecord) {
	const messages = record.messages ?? [];
	return {
		title: record.title,
		kind: record.kind === "practice" ? "practice" : "teach",
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
		version: record.version ?? CURRENT_CHAT_VERSION,
		messageCount: messages.length,
		phase: phaseAt3Lh(messages) as Phase3,
		pendingQuestion: danglingQuestionOf(messages) !== null,
		pendingProblem: activeProblemOf(messages) !== null,
	};
}

/** Overlay the authoritative metadata columns onto the stored record so a
 *  legacy row (or a row edited by hand) still reads exactly like the fs file.
 *  Absent `kind` on disk/read is teach — a practice marker is explicit. */
function overlayMeta(record: ChatRecord, row: ChatFullRow): ChatRecord {
	const out = { ...record };
	if (row.id !== undefined) out.id = row.id;
	if (row.title !== undefined) out.title = row.title;
	if (row.created_at !== undefined) out.createdAt = iso(row.created_at);
	if (row.updated_at !== undefined) out.updatedAt = iso(row.updated_at);
	if (row.version !== undefined) out.version = row.version;
	if (row.kind === "practice") out.kind = "practice";
	else delete out.kind;
	return out;
}

const META_COLUMNS = "id, title, kind, created_at, updated_at, version, message_count, phase, pending_question, pending_problem";

/** All writes go through here: stamp the current schema version, recompute
 *  the summary columns, and keep image snapshots OUT of the record JSONB
 *  (they live in chat_image_snapshots and are reattached on read). */
async function persistRecord(client: PoolClient, owner: string, record: ChatRecord): Promise<void> {
	const saved: ChatRecord = { ...record, version: CURRENT_CHAT_VERSION };
	const { imageSnapshots: _snapshots, ...withoutSnapshots } = saved;
	const s = summaryOf(saved);
	await client.query(
		`UPDATE chats
		    SET title = $3, kind = $4, created_at = $5, updated_at = $6, version = $7,
		        message_count = $8, phase = $9, pending_question = $10, pending_problem = $11,
		        record = $12
		  WHERE owner_id = $1 AND id = $2`,
		[
			owner, saved.id,
			s.title, s.kind, s.createdAt, s.updatedAt, s.version,
			s.messageCount, s.phase, s.pendingQuestion, s.pendingProblem,
			JSON.stringify(withoutSnapshots),
		],
	);
}

/** BEGIN / work / COMMIT with a rollback on any failure. The caller never
 *  sees a half-written record, and a rejected transaction releases its
 *  client back to the pool in every path. */
async function withTx<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		const result = await fn(client);
		await client.query("COMMIT");
		return result;
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
	}
}

async function loadLocked(client: PoolClient, owner: string, id: string): Promise<ChatRecord | null> {
	const { rows } = await client.query<ChatFullRow>(
		`SELECT ${META_COLUMNS}, record FROM chats WHERE owner_id = $1 AND id = $2 FOR UPDATE`,
		[owner, id],
	);
	const row = rows[0];
	if (!row) return null;
	const record = parseRecord(row.record);
	if (!record) return null;
	// Honest refusal, same as the fs getChat downgrade guard.
	const v = record.version;
	if (typeof v === "number" && v > CURRENT_CHAT_VERSION) {
		console.error(`[chat ${id}] record stamped with schema version ${v} > ${CURRENT_CHAT_VERSION} — this app build is older; refusing to read it`);
		return null;
	}
	return overlayMeta(record, row);
}

export function createPostgresChatStore(pool: Pool, options?: PostgresChatStoreOptions): ChatStore {
	return {
		async createChat(title, kind) {
			const owner = pgOwner();
			const now = new Date().toISOString();
			const record: ChatRecord = {
				id: `chat_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`,
				title: title.trim() || "Untitled session",
				createdAt: now,
				updatedAt: now,
				messages: [],
				// Practice carries the marker; teach stays ABSENT (absence reads as teach).
				...(kind === "practice" ? { kind: "practice" as const } : {}),
			};
			const s = summaryOf(record);
			const { imageSnapshots: _snapshots, ...stored } = record;
			await pool.query(
				`INSERT INTO chats
				 (owner_id, id, title, kind, created_at, updated_at, version, message_count,
				  phase, pending_question, pending_problem, record)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
				[
					owner, record.id, s.title, s.kind, s.createdAt, s.updatedAt, s.version,
					s.messageCount, s.phase, s.pendingQuestion, s.pendingProblem,
					JSON.stringify(stored),
				],
			);
			emit("chats-changed", {});
			return { ...record, version: CURRENT_CHAT_VERSION };
		},

		async getChat(id) {
			const owner = pgOwner();
			const { rows } = await pool.query<ChatFullRow>(
				`SELECT ${META_COLUMNS}, record FROM chats WHERE owner_id = $1 AND id = $2`,
				[owner, id],
			);
			const row = rows[0];
			if (!row) return null;
			const record = parseRecord(row.record);
			if (!record) return null;
			const v = record.version;
			if (typeof v === "number" && v > CURRENT_CHAT_VERSION) {
				console.error(`[chat ${id}] record stamped with schema version ${v} > ${CURRENT_CHAT_VERSION} — this app build is older; refusing to read it`);
				return null;
			}
			const merged = overlayMeta(record, row);
			const { rows: snapshots } = await pool.query<SnapshotRow>(
				`SELECT snapshot_id, mime_type, data, blob_key, width, height
				   FROM chat_image_snapshots WHERE owner_id = $1 AND chat_id = $2`,
				[owner, id],
			);
			if (snapshots.length > 0) {
				const images: Record<string, ImageSnapshot> = {};
				for (const snap of snapshots) {
					// Legacy rows carry inline base64; offloaded rows carry a blob key.
					let data = snap.data;
					if (data === null && snap.blob_key && options?.blobStore) {
						const blob = await options.blobStore.get(snap.blob_key);
						if (blob) data = Buffer.from(blob.body).toString("base64");
					}
					if (data === null) continue; // a missing blob cannot be rendered
					images[snap.snapshot_id] = {
						mimeType: snap.mime_type as ImageSnapshot["mimeType"],
						data,
						width: snap.width,
						height: snap.height,
					};
				}
				if (Object.keys(images).length > 0) merged.imageSnapshots = images;
				else delete merged.imageSnapshots;
			} else {
				// Match the fs shape: the key is absent until the first picture.
				delete merged.imageSnapshots;
			}
			return merged;
		},

		async listChats() {
			const owner = pgOwner();
			// Lightweight columns ONLY — never record JSONB, never snapshots.
			const { rows } = await pool.query<ChatMetaRow>(
				`SELECT ${META_COLUMNS} FROM chats WHERE owner_id = $1 ORDER BY updated_at DESC`,
				[owner],
			);
			return rows.map((row): ChatSummary => ({
				id: row.id,
				title: row.title,
				kind: row.kind === "practice" ? "practice" : "teach",
				createdAt: iso(row.created_at),
				updatedAt: iso(row.updated_at),
				messageCount: row.message_count,
				phase: row.phase as Phase3,
				pendingQuestion: row.pending_question,
				pendingProblem: row.pending_problem,
			}));
		},

		async saveMessages(id, messages: LhMessage[]) {
			const owner = pgOwner();
			await withTx(pool, async (client) => {
				const record = await loadLocked(client, owner, id);
				if (!record) throw new Error(`Chat not found: ${id}`);
				record.messages = messages;
				record.updatedAt = new Date().toISOString();
				await persistRecord(client, owner, record);
			});
			// SILENT by the events law — turn-started/turn-settled announce it.
		},

		async saveImageSnapshot(id, snapshotId, image: ImageSnapshot) {
			const bytes = Buffer.from(image.data, "base64");
			if (!/^[a-f0-9]{64}$/.test(snapshotId) || createHash("sha256").update(bytes).digest("hex") !== snapshotId) {
				throw new Error("Invalid image snapshot identity");
			}
			const owner = pgOwner();
			await withTx(pool, async (client) => {
				const record = await loadLocked(client, owner, id);
				if (!record) throw new Error(`Chat not found: ${id}`);
				// A snapshot is immutable by its SHA-256 identity: a repeat is
				// a no-op, and the picture never bumps conversation activity.
				if (options?.blobStore && options.offloadSnapshots) {
					const blobKey = ownerBlobKey(owner, "images", `${snapshotId}.${extForMime(image.mimeType)}`);
					await options.blobStore.put(blobKey, new Uint8Array(bytes), image.mimeType);
					await client.query(
						`INSERT INTO chat_image_snapshots
						 (owner_id, chat_id, snapshot_id, mime_type, data, blob_key, width, height)
						 VALUES ($1, $2, $3, $4, NULL, $5, $6, $7)
						 ON CONFLICT (owner_id, chat_id, snapshot_id) DO NOTHING`,
						[owner, id, snapshotId, image.mimeType, blobKey, image.width, image.height],
					);
					return;
				}
				await client.query(
					`INSERT INTO chat_image_snapshots
					 (owner_id, chat_id, snapshot_id, mime_type, data, width, height)
					 VALUES ($1, $2, $3, $4, $5, $6, $7)
					 ON CONFLICT (owner_id, chat_id, snapshot_id) DO NOTHING`,
					[owner, id, snapshotId, image.mimeType, image.data, image.width, image.height],
				);
			});
		},

		async saveTree(id, tree: PlanTree) {
			const owner = pgOwner();
			await withTx(pool, async (client) => {
				const record = await loadLocked(client, owner, id);
				if (!record) throw new Error(`Chat not found: ${id}`);
				record.tree = tree;
				// Tree edits piggyback on the turn's saveMessages: no activity bump.
				await persistRecord(client, owner, record);
			});
		},

		async appendTurnUsage(id, entry: TurnUsage) {
			const owner = pgOwner();
			await withTx(pool, async (client) => {
				const record = await loadLocked(client, owner, id);
				if (!record) throw new Error(`Chat not found: ${id}`);
				if (record.turns?.some((t) => t.id === entry.id)) return; // idempotent
				record.turns = [...(record.turns ?? []), entry];
				await persistRecord(client, owner, record);
			});
		},

		async appendExtractionUsage(id, entry: ExtractionRunUsage) {
			const owner = pgOwner();
			await withTx(pool, async (client) => {
				const record = await loadLocked(client, owner, id);
				if (!record) throw new Error(`Chat not found: ${id}`);
				if (record.extractions?.some((r) => r.startedAt === entry.startedAt)) return; // idempotent
				record.extractions = [...(record.extractions ?? []), entry];
				await persistRecord(client, owner, record);
			});
		},

		async saveSettings(id, settings: ChatSettings) {
			const owner = pgOwner();
			await withTx(pool, async (client) => {
				const record = await loadLocked(client, owner, id);
				if (!record) throw new Error(`Chat not found: ${id}`);
				record.settings = settings;
				// A settings tweak is not conversation activity: updatedAt stays put.
				await persistRecord(client, owner, record);
			});
		},

		async renameChat(id, title) {
			const owner = pgOwner();
			const record = await withTx(pool, async (client) => {
				const found = await loadLocked(client, owner, id);
				if (!found) throw new Error(`Chat not found: ${id}`);
				found.title = title.trim() || "Untitled session";
				await persistRecord(client, owner, found);
				return found;
			});
			emit("chats-changed", {});
			return record;
		},

		async deleteChat(id) {
			const owner = pgOwner();
			const { rowCount } = await pool.query(
				"DELETE FROM chats WHERE owner_id = $1 AND id = $2",
				[owner, id],
			);
			const removed = (rowCount ?? 0) > 0;
			if (removed) emit("chats-changed", {}); // present-entry law
			return removed;
		},

		async updateSideChats(id, update) {
			const owner = pgOwner();
			let result: SideChatThread[] | null = null;
			await withTx(pool, async (client) => {
				const record = await loadLocked(client, owner, id);
				if (!record) return; // deleted mid-answer — null, not an error
				const next = update(record.sideChats ?? []);
				if (next.length > 0) record.sideChats = next;
				else delete record.sideChats;
				await persistRecord(client, owner, record);
				result = next;
			});
			// Silent and not conversation activity, like saveSettings.
			return result;
		},
	};
}
