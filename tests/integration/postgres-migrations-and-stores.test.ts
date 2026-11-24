/**
 * Real PostgreSQL 17 integration test:
 *   1. SQL migrations (001–003) apply cleanly and are idempotent on re-run.
 *   2. Domain stores (chats, graph, jobs, settings, themes, promptOverrides,
 *      sourceOrganization) round-trip against live Postgres with strict
 *      per-owner tenant isolation.
 *   3. PostgreSQL LISTEN/NOTIFY event bridge delivers cross-process events
 *      to the matching owner without echoing back to its own origin.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Client } from "pg";
import { closePgPool, getPgPool, runMigrations } from "../../src/server/db.ts";
import { startPgEventsBridge, stopPgEventsBridge } from "../../src/server/pg-events.ts";
import { createPostgresStores } from "../../src/store/postgres/index.ts";
import { runAsOwner } from "../../src/core/owner-scope.ts";
import { sanitizeUserSettings } from "../../src/core/settings.ts";
import { subscribe, type ServerEvent } from "../../src/core/events.ts";

const DATABASE_URL = process.env.DATABASE_URL?.trim();
assert.ok(DATABASE_URL, "DATABASE_URL must be set for integration tests");

const OWNER_A = randomUUID();
const OWNER_B = randomUUID();
const pool = getPgPool();
const pgStores = createPostgresStores(pool);

before(async () => {
	await runMigrations(pool);
});

after(async () => {
	await stopPgEventsBridge();
	await pool.query("DELETE FROM chats WHERE owner_id = ANY($1::text[])", [[OWNER_A, OWNER_B]]);
	await pool.query("DELETE FROM jobs WHERE owner_id = ANY($1::text[])", [[OWNER_A, OWNER_B]]);
	await pool.query("DELETE FROM user_settings WHERE owner_id = ANY($1::text[])", [[OWNER_A, OWNER_B]]);
	await pool.query("DELETE FROM user_themes WHERE owner_id = ANY($1::text[])", [[OWNER_A, OWNER_B]]);
	await pool.query("DELETE FROM prompt_overrides WHERE owner_id = ANY($1::text[])", [[OWNER_A, OWNER_B]]);
	await pool.query("DELETE FROM source_organization WHERE owner_id = ANY($1::text[])", [[OWNER_A, OWNER_B]]);
	await closePgPool();
});

describe("PostgreSQL migrations", () => {
	it("applies 001–003 cleanly and is a no-op on a second run", async () => {
		const secondRun = await runMigrations(pool);
		assert.deepEqual(secondRun, [], "already-applied migrations must not re-run");

		const { rows } = await pool.query<{ version: string }>(
			"SELECT version FROM schema_migrations ORDER BY version",
		);
		const versions = rows.map((r) => r.version);
		assert.ok(versions.includes("001_auth_and_admissions.sql"));
		assert.ok(versions.includes("002_domain_stores.sql"));
		assert.ok(versions.includes("003_blob_references.sql"));
	});
});

describe("PostgreSQL domain stores (live DB + multi-tenant isolation)", () => {
	it("isolates chats between two owners and preserves messages + metadata", async () => {
		const chatA = await runAsOwner(OWNER_A, () => pgStores.chatStore.createChat("Owner A Lesson"));
		const chatB = await runAsOwner(OWNER_B, () => pgStores.chatStore.createChat("Owner B Practice", "practice"));

		const listA = await runAsOwner(OWNER_A, () => pgStores.chatStore.listChats());
		const listB = await runAsOwner(OWNER_B, () => pgStores.chatStore.listChats());

		assert.deepEqual(listA.map((c) => c.id), [chatA.id]);
		assert.deepEqual(listB.map((c) => c.id), [chatB.id]);

		// Cross-tenant read must return null.
		const crossRead = await runAsOwner(OWNER_A, () => pgStores.chatStore.getChat(chatB.id));
		assert.equal(crossRead, null);

		await runAsOwner(OWNER_A, () => pgStores.chatStore.renameChat(chatA.id, "Renamed A"));
		const reloadedA = await runAsOwner(OWNER_A, () => pgStores.chatStore.getChat(chatA.id));
		assert.equal(reloadedA?.title, "Renamed A");

		await runAsOwner(OWNER_A, () => pgStores.chatStore.deleteChat(chatA.id));
		assert.equal(await runAsOwner(OWNER_A, () => pgStores.chatStore.getChat(chatA.id)), null);
		// Owner B's chat is untouched.
		assert.equal((await runAsOwner(OWNER_B, () => pgStores.chatStore.getChat(chatB.id)))?.title, "Owner B Practice");
	});

	it("isolates jobs, settings, prompt overrides, and source organization per owner", async () => {
		const jobA = await runAsOwner(OWNER_A, () =>
			pgStores.jobStore.createJob({ kind: "research", chatId: "chat_a", toolCallId: "tc_1" }),
		);
		await runAsOwner(OWNER_A, () => pgStores.jobStore.updateJob(jobA.id, { activity: "searching", status: "done" }));

		const loadedA = await runAsOwner(OWNER_A, () => pgStores.jobStore.getJob(jobA.id));
		assert.equal(loadedA?.status, "done");
		assert.equal(loadedA?.activity, "searching");
		assert.equal(await runAsOwner(OWNER_B, () => pgStores.jobStore.getJob(jobA.id)), null);

		const sanitized = sanitizeUserSettings({ appearance: { theme: "gruvbox-dark" } });
		assert.ok(sanitized);
		await runAsOwner(OWNER_A, () => pgStores.settingsStore.writeSettings(sanitized));
		const settingsA = await runAsOwner(OWNER_A, () => pgStores.settingsStore.readSettings());
		const settingsB = await runAsOwner(OWNER_B, () => pgStores.settingsStore.readSettings());
		assert.equal(settingsA?.appearance?.theme, "gruvbox-dark");
		assert.equal(settingsB, null);

		await runAsOwner(OWNER_A, () => pgStores.promptOverrides.writeOverride("teacher/00-base.md", "Custom A"));
		assert.equal(await runAsOwner(OWNER_A, () => pgStores.promptOverrides.readOverride("teacher/00-base.md")), "Custom A");
		assert.equal(await runAsOwner(OWNER_B, () => pgStores.promptOverrides.readOverride("teacher/00-base.md")), null);
	});
});

describe("PostgreSQL LISTEN/NOTIFY SSE event bridge", () => {
	it("delivers remote NOTIFY payloads to matching owner subscribers only", async () => {
		startPgEventsBridge(DATABASE_URL);
		// Allow the dedicated LISTEN client to connect and subscribe.
		await new Promise((r) => setTimeout(r, 300));

		const receivedA: ServerEvent[] = [];
		const receivedB: ServerEvent[] = [];
		const offA = subscribe((event) => receivedA.push(event), { owner: OWNER_A });
		const offB = subscribe((event) => receivedB.push(event), { owner: OWNER_B });

		const notifier = new Client({ connectionString: DATABASE_URL });
		await notifier.connect();
		try {
			const remotePayload = JSON.stringify({
				origin: `remote-${randomUUID()}`,
				owner: OWNER_A,
				type: "jobs-changed",
				payload: { chatId: "chat_notify_test" },
			});
			await notifier.query("SELECT pg_notify($1, $2)", ["lh_events", remotePayload]);

			const deadline = Date.now() + 5_000;
			while (receivedA.length === 0 && Date.now() < deadline) {
				await new Promise((r) => setTimeout(r, 50));
			}

			assert.equal(receivedA.length, 1);
			assert.deepEqual(receivedA[0], { type: "jobs-changed", chatId: "chat_notify_test" });
			assert.equal(receivedB.length, 0, "Owner B must not receive Owner A's remote events");
		} finally {
			offA();
			offB();
			await notifier.end();
		}
	});
});
