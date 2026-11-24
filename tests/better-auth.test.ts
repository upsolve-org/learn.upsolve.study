import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it, beforeEach, afterEach } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-better-auth-"));
process.env.LH_DATA_DIR = dataDir;
const origin = "http://localhost";
const OWNER = "9d0409ac-ee31-4944-8cc8-56ef5eb1bed5";
const SPOOF = "0f0e0d0c-0b0a-4908-8706-050403020100";

const { proxy } = await import("../proxy.ts");
const { NextRequest } = await import("next/server");
const { setAuthSessionResolver, hashPassword, verifyPassword } = await import("../src/server/auth.ts");
const { hostedConfigurationError } = await import("../src/core/hosted.ts");
const { getAuthTables } = await import("@better-auth/core/db");

const ENV_KEYS = ["HOSTED_MODE", "DATABASE_URL", "BETTER_AUTH_SECRET", "HOSTED_PILOT_EMAIL", "ADMIN_EMAIL"] as const;
const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
let user: { id: string; email: string } | null = null;

beforeEach(() => {
	user = null;
	Object.assign(process.env, {
		HOSTED_MODE: "on",
		DATABASE_URL: "postgresql://unused",
		BETTER_AUTH_SECRET: "secret",
		HOSTED_PILOT_EMAIL: undefined,
		ADMIN_EMAIL: undefined,
	});
	fs.writeFileSync(path.join(dataDir, "admissions.json"), JSON.stringify({ version: 1, emails: ["invited@example.test"] }));
	setAuthSessionResolver(async () => user);
});
afterEach(() => {
	setAuthSessionResolver(undefined);
	for (const key of ENV_KEYS) {
		const value = saved[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

describe("bcrypt password compatibility", () => {
	it("hashes fresh passwords at Supabase's cost 10 and verifies them", async () => {
		const stored = await hashPassword("fresh-password");
		assert.match(stored, /^\$2[aby]\$10\$/);
		assert.equal(await verifyPassword({ hash: stored, password: "fresh-password" }), true);
		assert.equal(await verifyPassword({ hash: stored, password: "wrong" }), false);
	});

	it("verifies a real Supabase-format $2a$10$ hash without any reset", async () => {
		// Generated with bcrypt cost 10: the format GoTrue writes to
		// auth.users.encrypted_password. Migrated users keep this exact hash.
		const supabaseHash = "$2a$10$5OHSwHtzIUI8WDCiPvOcL.d0oZvnOcaSU41UOOO.XMIFtadJxvzza";
		assert.equal(await verifyPassword({ hash: supabaseHash, password: "upsolve-supabase-password" }), true);
		assert.equal(await verifyPassword({ hash: supabaseHash, password: "not-the-password" }), false);
		assert.equal(await verifyPassword({ hash: "$2y$10$5OHSwHtzIUI8WDCiPvOcL.d0oZvnOcaSU41UOOO.XMIFtadJxvzza", password: "upsolve-supabase-password" }), true);
		assert.equal(await verifyPassword({ hash: "", password: "x" }), false);
		assert.equal(await verifyPassword({ hash: "not-a-hash", password: "x" }), false);
	});
});

describe("hosted prerequisites", () => {
	it("requires DATABASE_URL and BETTER_AUTH_SECRET, nothing else", () => {
		assert.equal(hostedConfigurationError({ HOSTED_MODE: "on", DATABASE_URL: "postgresql://x", BETTER_AUTH_SECRET: "s" }), null);
		const error = hostedConfigurationError({ HOSTED_MODE: "on" }) ?? "";
		assert.match(error, /DATABASE_URL/);
		assert.match(error, /BETTER_AUTH_SECRET/);
		assert.doesNotMatch(error, /SUPABASE/);
	});
});

describe("Proxy and Better Auth's mount point", () => {
	it("lets every /api/auth/* request through with no session and strips spoofed owner headers", async () => {
		for (const apiPath of ["/api/auth", "/api/auth/get-session", "/api/auth/sign-in/email", "/api/auth/callback/google"]) {
			const response = await proxy(new NextRequest(new URL(apiPath, origin), {
				method: "POST",
				headers: { "x-lh-owner": SPOOF, "x-lh-operator": "1" },
			}));
			assert.equal(response.status, 200, apiPath);
			assert.equal(response.headers.get("x-middleware-request-x-lh-owner"), null, apiPath);
			assert.equal(response.headers.get("x-middleware-request-x-lh-operator"), null, apiPath);
		}
	});

	it("still protects /api/chats and forwards only the verified owner", async () => {
		const anonymous = await proxy(new NextRequest(new URL("/api/chats", origin), {
			headers: { "x-lh-owner": SPOOF, "x-lh-operator": "1" },
		}));
		assert.equal(anonymous.status, 401);
		assert.deepEqual(await anonymous.json(), { error: "Sign in with an admitted account." });

		user = { id: OWNER, email: "invited@example.test" };
		const admitted = await proxy(new NextRequest(new URL("/api/chats", origin), {
			headers: { "x-lh-owner": SPOOF, "x-lh-operator": "1" },
		}));
		assert.equal(admitted.status, 200);
		assert.equal(admitted.headers.get("x-middleware-request-x-lh-owner"), OWNER);
		assert.equal(admitted.headers.get("x-middleware-request-x-lh-operator"), null, "learner cannot self-declare operator");
	});
});

describe("SQL migration sanity", () => {
	const sql = readFileSync(new URL("../db/migrations/001_auth_and_admissions.sql", import.meta.url), "utf8");

	it("creates the tracking table and all four Better Auth tables idempotently", () => {
		for (const table of ["schema_migrations", "user", "session", "account", "verification"]) {
			assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS "?${table}"?\\s*\\(`), table);
		}
		assert.match(sql, /applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW\(\)/);
		const open = (sql.match(/\(/g) ?? []).length;
		const close = (sql.match(/\)/g) ?? []).length;
		assert.equal(open, close, "balanced parentheses");
		const withoutComments = sql.replace(/--[^\n]*/g, "");
		for (const statement of withoutComments.split(";").map((part) => part.trim()).filter(Boolean)) {
			assert.match(statement, /^CREATE (TABLE|INDEX)/, statement.slice(0, 60));
		}
	});

	it("uses the camelCase columns the installed Better Auth actually expects", () => {
		const tables = getAuthTables({});
		for (const name of ["user", "session", "account", "verification"] as const) {
			const table = tables[name];
			assert.ok(table, `better-auth defines ${name}`);
			for (const [field, definition] of Object.entries(table.fields)) {
				const column = definition.fieldName ?? field;
				assert.ok(
					sql.includes(`"${column}"`) || new RegExp(`\\b${column}\\b`).test(sql),
					`${name}.${column} (field ${field}) must exist in the migration`,
				);
			}
		}
		for (const index of ["session_userId_idx", "session_token_idx", "account_userId_idx", "verification_identifier_idx"]) {
			assert.ok(sql.includes(index), index);
		}
	});
});
