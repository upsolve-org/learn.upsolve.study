/**
 * GraphStore — the PostgreSQL adapter for the append-only ledgers and the
 * map-shaped bookkeeping files. Append order is the ledger's meaning: every
 * read ORDER BY seq ASC, exactly reproducing the fs JSONL line order.
 *
 * rewriteLedgers is the one destructive seam (session deletion wave 6). It
 * runs DELETE + re-INSERT for every provided ledger inside one transaction,
 * so a crash can never leave a half-purged graph and absent keys never touch
 * their ledger.
 */

import type { Pool, PoolClient } from "pg";
import type { GraphStore } from "../../core/ports.ts";
import type {
	CoverageEntry,
	ExtractionRunUsage,
	GraphChain,
	GraphNode,
	NotesSource,
	Position,
	SessionCheckpoint,
} from "../../core/contracts.ts";
import { pgOwner } from "./owner.ts";

type LedgerKey = "nodes" | "chains" | "checkpoints" | "coverage";

const LEDGER_TABLE: Record<LedgerKey, string> = {
	nodes: "graph_nodes",
	chains: "graph_chains",
	checkpoints: "graph_checkpoints",
	coverage: "graph_coverage",
};

/** pg parses JSONB; text-returning drivers/mocks are normalized here too. */
function payload<T>(value: unknown): T | null {
	if (typeof value === "string") {
		try { return JSON.parse(value) as T; } catch { return null; }
	}
	return value && typeof value === "object" ? (value as T) : null;
}

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

export function createPostgresGraphStore(pool: Pool): GraphStore {
	return {
		async appendNode(node: GraphNode) {
			await pool.query(
				"INSERT INTO graph_nodes (owner_id, id, payload) VALUES ($1, $2, $3::jsonb)",
				[pgOwner(), node.id, JSON.stringify(node)],
			);
		},

		async readNodes() {
			const { rows } = await pool.query<{ payload: unknown }>(
				"SELECT payload FROM graph_nodes WHERE owner_id = $1 ORDER BY seq ASC",
				[pgOwner()],
			);
			return rows.map((row) => payload<GraphNode>(row.payload)).filter((n): n is GraphNode => n !== null);
		},

		async appendChain(assertion: GraphChain) {
			await pool.query(
				"INSERT INTO graph_chains (owner_id, id, payload) VALUES ($1, $2, $3::jsonb)",
				[pgOwner(), assertion.id, JSON.stringify(assertion)],
			);
		},

		async readChains() {
			const { rows } = await pool.query<{ payload: unknown }>(
				"SELECT payload FROM graph_chains WHERE owner_id = $1 ORDER BY seq ASC",
				[pgOwner()],
			);
			return rows.map((row) => payload<GraphChain>(row.payload)).filter((n): n is GraphChain => n !== null);
		},

		async appendCheckpoint(checkpoint: SessionCheckpoint) {
			await pool.query(
				"INSERT INTO graph_checkpoints (owner_id, chat_id, payload) VALUES ($1, $2, $3::jsonb)",
				[pgOwner(), checkpoint.chatId, JSON.stringify(checkpoint)],
			);
		},

		async readCheckpoints() {
			const { rows } = await pool.query<{ payload: unknown }>(
				"SELECT payload FROM graph_checkpoints WHERE owner_id = $1 ORDER BY seq ASC",
				[pgOwner()],
			);
			return rows.map((row) => payload<SessionCheckpoint>(row.payload)).filter((n): n is SessionCheckpoint => n !== null);
		},

		async appendCoverage(entry: CoverageEntry) {
			await pool.query(
				"INSERT INTO graph_coverage (owner_id, chat_id, payload) VALUES ($1, $2, $3::jsonb)",
				[pgOwner(), entry.chatId, JSON.stringify(entry)],
			);
		},

		async readCoverage() {
			const { rows } = await pool.query<{ payload: unknown }>(
				"SELECT payload FROM graph_coverage WHERE owner_id = $1 ORDER BY seq ASC",
				[pgOwner()],
			);
			return rows.map((row) => payload<CoverageEntry>(row.payload)).filter((n): n is CoverageEntry => n !== null);
		},

		async upsertSource(source: NotesSource) {
			const owner = pgOwner();
			await withTx(pool, async (client) => {
				// An upsert keeps the existing record's usage log, exactly as
				// src/store/graph.ts does for a re-imported file.
				const { rows } = await client.query<{ payload: unknown }>(
					"SELECT payload FROM graph_sources WHERE owner_id = $1 AND id = $2 FOR UPDATE",
					[owner, source.id],
				);
				const prev = rows[0] ? payload<NotesSource>(rows[0].payload) : null;
				const merged: NotesSource = prev ? { ...source, extractions: prev.extractions } : source;
				await client.query(
					`INSERT INTO graph_sources (owner_id, id, payload) VALUES ($1, $2, $3::jsonb)
					 ON CONFLICT (owner_id, id) DO UPDATE SET payload = EXCLUDED.payload`,
					[owner, source.id, JSON.stringify(merged)],
				);
			});
		},

		async readSources() {
			const { rows } = await pool.query<{ payload: unknown }>(
				"SELECT payload FROM graph_sources WHERE owner_id = $1 ORDER BY id ASC",
				[pgOwner()],
			);
			return rows.map((row) => payload<NotesSource>(row.payload)).filter((n): n is NotesSource => n !== null);
		},

		async deleteSources(ids: ReadonlySet<string>) {
			if (ids.size === 0) return 0;
			const { rowCount } = await pool.query(
				"DELETE FROM graph_sources WHERE owner_id = $1 AND id = ANY($2::text[])",
				[pgOwner(), [...ids]],
			);
			return rowCount ?? 0;
		},

		async appendSourceUsage(id: string, entry: ExtractionRunUsage) {
			const owner = pgOwner();
			await withTx(pool, async (client) => {
				const { rows } = await client.query<{ payload: unknown }>(
					"SELECT payload FROM graph_sources WHERE owner_id = $1 AND id = $2 FOR UPDATE",
					[owner, id],
				);
				const source = rows[0] ? payload<NotesSource>(rows[0].payload) : null;
				if (!source) return; // no such source — nothing to bill against
				if (source.extractions?.some((r) => r.startedAt === entry.startedAt)) return; // idempotent
				source.extractions = [...(source.extractions ?? []), entry];
				await client.query(
					"UPDATE graph_sources SET payload = $3::jsonb WHERE owner_id = $1 AND id = $2",
					[owner, id, JSON.stringify(source)],
				);
			});
		},

		async readPositions() {
			const { rows } = await pool.query<{ positions: unknown }>(
				"SELECT positions FROM graph_positions WHERE owner_id = $1",
				[pgOwner()],
			);
			const positions = payload<Record<string, Position>>(rows[0]?.positions);
			return positions ?? {};
		},

		async writePositions(positions: Record<string, Position>) {
			await pool.query(
				`INSERT INTO graph_positions (owner_id, positions, updated_at)
				 VALUES ($1, $2::jsonb, NOW())
				 ON CONFLICT (owner_id) DO UPDATE SET positions = EXCLUDED.positions, updated_at = NOW()`,
				[pgOwner(), JSON.stringify(positions)],
			);
		},

		async rewriteLedgers(next) {
			const owner = pgOwner();
			await withTx(pool, async (client) => {
				for (const key of Object.keys(next) as LedgerKey[]) {
					const table = LEDGER_TABLE[key];
					if (!table) continue;
					await client.query(`DELETE FROM ${table} WHERE owner_id = $1`, [owner]);
					const records = next[key];
					for (const record of records ?? []) {
						// checkpoints/coverage key on chat_id; nodes/chains on id.
						const keyValue = key === "checkpoints" || key === "coverage"
							? (record as { chatId?: string }).chatId ?? ""
							: (record as { id?: string }).id ?? "";
						const keyColumn = key === "checkpoints" || key === "coverage" ? "chat_id" : "id";
						await client.query(
							`INSERT INTO ${table} (owner_id, ${keyColumn}, payload) VALUES ($1, $2, $3::jsonb)`,
							[owner, keyValue, JSON.stringify(record)],
						);
					}
				}
			});
		},
	};
}
