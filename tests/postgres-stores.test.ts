/**
 * PR 5 pins: the migration's owner-scoped schema, every Postgres adapter's
 * critical SQL/semantics against a light in-memory Pool mock, the core event
 * bridge's owner isolation/no-echo law, and the storage-backend env switch.
 *
 * The mock records SQL instead of talking to a database: these tests pin
 * the contract (which columns are read, which writes are transactional,
 * which events are emitted), while a real Postgres is exercised by the
 * migration script in deployment.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import type { Pool } from "pg";
import { deliverRemoteEvent, emit, registerEventBridge, subscribe, type EventEnvelope, type ServerEvent } from "../src/core/events.ts";
import { runAsOwner } from "../src/core/owner-scope.ts";
import { sanitizeUserSettings } from "../src/core/settings.ts";
import { createPostgresStores } from "../src/store/postgres/index.ts";
import { configureStores, postgresStorageEnabled, stores } from "../src/server/stores.ts";

interface Call { sql: string; params: unknown[] }
interface Reply { rows: unknown[]; rowCount?: number }
type Responder = (call: Call) => Reply;

function makePool(responder: Responder) {
	const calls: Call[] = [];
	const clients: Call[][] = [];
	const run = (call: Call) => { calls.push(call); return responder(call); };
	const pool = {
		calls,
		clients,
		async query(sql: string, params: unknown[] = []) { return run({ sql, params }); },
		async connect() {
			const history: Call[] = [];
			clients.push(history);
			return {
				query(sql: string, params: unknown[] = []) {
					const call = { sql, params };
					history.push(call);
					return Promise.resolve(responder(call));
				},
				release() {},
			};
		},
	};
	return pool as unknown as Pool & { calls: Call[]; clients: Call[][] };
}

const ISO = "2026-01-01T00:00:00.000Z";
const recordWith = (extra: Record<string, unknown> = {}) => ({
	id: "chat_1", title: "Title", createdAt: ISO, updatedAt: ISO, messages: [], version: 2, ...extra,
});
const chatRow = (extra: Record<string, unknown> = {}) => ({
	id: "chat_1", title: "Title", kind: "teach", created_at: ISO, updated_at: ISO,
	version: 2, message_count: 0, phase: "probe", pending_question: false, pending_problem: false,
	record: recordWith(extra),
});

// ─── migration ────────────────────────────────────────────────────────────────

describe("002_domain_stores.sql", () => {
	const sql = readFileSync(path.join(process.cwd(), "db", "migrations", "002_domain_stores.sql"), "utf8");

	it("creates every domain table idempotently", () => {
		for (const table of [
			"chats", "chat_image_snapshots", "graph_nodes", "graph_chains", "graph_checkpoints",
			"graph_coverage", "graph_sources", "graph_positions", "source_organization", "jobs",
			"user_settings", "user_themes", "prompt_overrides", "admissions", "signup_requests",
			"issued_credentials",
		]) {
			assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`), `missing table ${table}`);
		}
	});

	it("adds every owner-scoped index (and the escalation/cascade rules)", () => {
		for (const index of [
			"chats_owner_updated_idx", "graph_nodes_owner_seq_idx", "graph_chains_owner_seq_idx",
			"graph_checkpoints_owner_seq_idx", "graph_coverage_owner_seq_idx", "jobs_owner_chat_idx",
		]) {
			assert.match(sql, new RegExp(`CREATE INDEX IF NOT EXISTS ${index}\\b`), `missing index ${index}`);
		}
		assert.match(sql, /ON DELETE CASCADE/);
		assert.match(sql, /PRIMARY KEY \(owner_id, id\)/);
	});
});

// ─── stores ───────────────────────────────────────────────────────────────────

describe("createPostgresStores", () => {
	it("returns all seven adapters", () => {
		const pool = makePool(() => ({ rows: [] }));
		const stores = createPostgresStores(pool);
		assert.deepEqual(Object.keys(stores).sort(), [
			"chatStore", "graphStore", "jobStore", "promptOverrides", "settingsStore",
			"sourceOrganizationStore", "themeStore",
		]);
	});

	it("listChats reads ONLY lightweight metadata columns — never record JSONB/snapshots", async () => {
		const pool = makePool(({ sql }) =>
			sql.includes("FROM chats") ? { rows: [chatRow()] } : { rows: [] },
		);
		const rows = await createPostgresStores(pool).chatStore.listChats();
		const select = pool.calls.find((c) => c.sql.startsWith("SELECT"))!;
		assert.match(select.sql, /SELECT id, title, kind, created_at, updated_at, version, message_count, phase, pending_question, pending_problem FROM chats/);
		assert.match(select.sql, /ORDER BY updated_at DESC/);
		assert.doesNotMatch(select.sql, /\brecord\b/i, "the sidebar list must never select the record JSONB");
		assert.doesNotMatch(select.sql, /image_snapshots/i);
		assert.equal(rows[0]?.messageCount, 0);
		assert.equal(rows[0]?.kind, "teach");
	});

	it("saveImageSnapshot validates the SHA-256 identity before touching the DB", async () => {
		const pool = makePool(({ sql }) => sql.includes("FOR UPDATE") ? { rows: [chatRow()] } : { rows: [] });
		const store = createPostgresStores(pool).chatStore;
		const data = Buffer.from("picture").toString("base64");
		await assert.rejects(
			async () => { await store.saveImageSnapshot("chat_1", "not-a-sha256", { mimeType: "image/png", data, width: 1, height: 1 }); },
			/Invalid image snapshot identity/,
		);
		assert.equal(pool.calls.length, 0, "a bad hash must not write anything");

		const id = createHash("sha256").update(Buffer.from(data, "base64")).digest("hex");
		await store.saveImageSnapshot("chat_1", id, { mimeType: "image/png", data, width: 1, height: 1 });
		const insert = pool.clients[0]!.find((c) => c.sql.includes("INSERT INTO chat_image_snapshots"));
		assert.ok(insert, "the picture is written to chat_image_snapshots");
		assert.equal(insert!.params[2], id);
		assert.equal(insert!.params[3], "image/png");
	});

	it("updateSideChats is a BEGIN / SELECT FOR UPDATE / COMMIT read-modify-write", async () => {
		const thread = (id: string) => ({
			id, anchor: { messageId: "m", partId: "p", blockIndex: 0, blockText: "" },
			open: true, createdAt: ISO, messages: [],
		}) as never;
		const pool = makePool(({ sql }) => sql.includes("FOR UPDATE") ? { rows: [chatRow({ sideChats: [thread("old")] })] } : { rows: [] });
		const result = await createPostgresStores(pool).chatStore.updateSideChats("chat_1", (threads) => [...threads, thread("new")]);
		assert.deepEqual(result, [thread("old"), thread("new")]);
		const calls = pool.clients[0]!.map((c) => c.sql);
		assert.equal(calls[0], "BEGIN");
		assert.match(calls[1]!, /SELECT .* FROM chats .* FOR UPDATE/);
		assert.match(calls[2]!, /UPDATE chats\s+SET/);
		assert.equal(calls[3], "COMMIT");
	});

	it("saveMessages bumps updatedAt and recomputes the summary columns", async () => {
		const pool = makePool(({ sql }) => sql.includes("FOR UPDATE") ? { rows: [chatRow()] } : { rows: [] });
		await createPostgresStores(pool).chatStore.saveMessages("chat_1", []);
		const update = pool.clients[0]!.find((c) => c.sql.startsWith("UPDATE chats"))!;
		assert.match(update.sql, /message_count = \$8, phase = \$9, pending_question = \$10, pending_problem = \$11,[\s\S]*record = \$12/);
		assert.equal(update.params.length, 12);
	});

	it("rewriteLedgers deletes + re-inserts inside one transaction, in order", async () => {
		const pool = makePool(() => ({ rows: [] }));
		await createPostgresStores(pool).graphStore.rewriteLedgers({
			nodes: [
				{ id: "n1", name: "A", statement: "a", aliases: [], createdAt: ISO, provenance: [] },
				{ id: "n2", name: "B", statement: "b", aliases: [], createdAt: ISO, provenance: [] },
			],
		});
		const calls = pool.clients[0]!.map((c) => c.sql);
		assert.equal(calls[0], "BEGIN");
		assert.ok(calls.includes("DELETE FROM graph_nodes WHERE owner_id = $1"));
		assert.equal(calls.filter((sql) => sql.startsWith("INSERT INTO graph_nodes")).length, 2);
		assert.equal(calls.at(-1), "COMMIT");
	});

	it("jobs emit jobs-changed on create and are silent for a missing update target", async () => {
		const pool = makePool(() => ({ rows: [] }));
		const jobStore = createPostgresStores(pool).jobStore;
		const got: ServerEvent[] = [];
		const off = subscribe((event) => got.push(event));
		try {
			const job = await jobStore.createJob({ kind: "visual", chatId: "chat_1", toolCallId: "tc_1" });
			assert.equal(job.status, "running");
			const unchanged = await jobStore.updateJob("missing", { activity: "x" });
			assert.equal(unchanged, null);
			assert.deepEqual(got, [{ type: "jobs-changed", chatId: "chat_1" }]);
		} finally {
			off();
		}
	});

	it("settings sanitizes on both read and write", async () => {
		const raw = { version: 99, general: { ExtraNonsense: 1 } };
		const pool = makePool(({ sql }) =>
			sql.startsWith("SELECT settings") ? { rows: [{ settings: raw }] } : { rows: [] },
		);
		const store = createPostgresStores(pool).settingsStore;
		const stored = sanitizeUserSettings(raw)!;
		await store.writeSettings(stored);
		const write = pool.calls.find((c) => c.sql.startsWith("INSERT INTO user_settings"))!;
		assert.deepEqual(JSON.parse(String(write.params[1])), stored);
		assert.deepEqual(await store.readSettings(), stored);
	});
});

// ─── core event bridge ────────────────────────────────────────────────────────

describe("external event bridge", () => {
	it("delivers remote events only to the matching owner and never echoes", () => {
		const OWNER_A = "11111111-1111-1111-1111-111111111111";
		const OWNER_B = "22222222-2222-2222-2222-222222222222";
		const published: EventEnvelope[] = [];
		const offBridge = registerEventBridge((envelope) => published.push(envelope));
		const gotA: ServerEvent[] = [];
		const gotB: ServerEvent[] = [];
		const unscoped: ServerEvent[] = [];
		const offA = subscribe((event) => gotA.push(event), { owner: OWNER_A });
		const offB = subscribe((event) => gotB.push(event), { owner: OWNER_B });
		const offAll = subscribe((event) => unscoped.push(event));
		try {
			deliverRemoteEvent("chats-changed", {}, OWNER_A);
			assert.deepEqual(gotA, [{ type: "chats-changed" }]);
			assert.deepEqual(gotB, []);
			assert.equal(published.length, 0, "a remote event must NOT be re-published to Postgres");

			runAsOwner(OWNER_A, () => emit("turn-started", { chatId: "c1" }));
			assert.equal(published.length, 1);
			assert.equal(published[0]!.type, "turn-started");
			assert.equal(published[0]!.owner, OWNER_A);
			assert.equal(gotA.length, 2);
			assert.equal(gotB.length, 0, "owner B never sees owner A's local emit either");
			assert.equal(unscoped.length, 2, "legacy unscoped subscribers still see everything");

			// Unknown event names and malformed payloads are ignored.
			deliverRemoteEvent("not-an-event" as never, {}, OWNER_A);
			deliverRemoteEvent("chats-changed", "garbage", OWNER_A);
			assert.equal(gotA.length, 3);
		} finally {
			offA(); offB(); offAll(); offBridge();
		}
	});

	it("a throwing publisher never breaks emit", () => {
		const offBridge = registerEventBridge(() => { throw new Error("DB down"); });
		const got: ServerEvent[] = [];
		const off = subscribe((event) => got.push(event));
		try {
			assert.doesNotThrow(() => emit("chats-changed", {}));
			assert.equal(got.length, 1);
		} finally {
			off(); offBridge();
		}
	});
});

// ─── backend selection ────────────────────────────────────────────────────────

describe("postgresStorageEnabled", () => {
	it("opts in explicitly, defaults on in hosted mode, and honors an explicit fs", () => {
		assert.equal(postgresStorageEnabled({ STORAGE_BACKEND: "postgres" }), true);
		assert.equal(postgresStorageEnabled({ HOSTED_MODE: "on", DATABASE_URL: "postgres://x" }), true);
		assert.equal(postgresStorageEnabled({ STORAGE_BACKEND: "fs", HOSTED_MODE: "on", DATABASE_URL: "postgres://x" }), false);
		assert.equal(postgresStorageEnabled({ HOSTED_MODE: "on" }), false);
		assert.equal(postgresStorageEnabled({ DATABASE_URL: "postgres://x" }), false);
		assert.equal(postgresStorageEnabled({}), false);
	});

	it("configureStores swaps adapters transparently even for pre-captured references", async () => {
		const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
		const captured = stores.chatStore;
		const pool = makePool(() => ({ rows: [] }));
		const pg = createPostgresStores(pool);
		const restore = configureStores(pg);
		try {
			const list = await runAsOwner(owner, () => captured.listChats());
			assert.deepEqual(list, []);
			assert.ok(pool.calls.some((c) => /FROM chats WHERE owner_id = \$1/.test(c.sql)));
		} finally {
			restore();
		}
	});

	// Next.js compiles instrumentation.ts and the routes as separate module
	// entries: boot's configureStores() runs in one copy of stores.ts, the
	// routes read another. Regression for the 2026-11-24 cutover, where the
	// routes kept the fs adapters while the worker read PostgreSQL.
	it("configureStores in one module copy reaches every other copy (instrumentation vs routes)", async () => {
		const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
		const routeCopy = await import(new URL("../src/server/stores.ts?route-entry", import.meta.url).href) as typeof import("../src/server/stores.ts");
		assert.notEqual(routeCopy.stores, stores, "the test must exercise a distinct module instance");
		const pool = makePool(() => ({ rows: [] }));
		const restore = configureStores(createPostgresStores(pool));
		try {
			const list = await runAsOwner(owner, () => routeCopy.stores.chatStore.listChats());
			assert.deepEqual(list, []);
			assert.ok(pool.calls.some((c) => /FROM chats WHERE owner_id = \$1/.test(c.sql)));
		} finally {
			restore();
		}
	});
});
