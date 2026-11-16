import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach, mock } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// config.ts resolves LH_DATA_DIR at module load; the imports below are dynamic.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-credentials-"));
process.env.LH_DATA_DIR = dataDir;

const {
	provisionAccount, issuedCredentials, forgetIssued, provisioningAvailable, generatePassword,
} = await import("../src/core/hosted-credentials.ts");

const ENV = {
	HOSTED_MODE: "on",
	NEXT_PUBLIC_SUPABASE_URL: "https://supabase.invalid",
	NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "k",
	SUPABASE_DB_URL: "postgresql://unused",
	SUPABASE_INTERNAL_URL: "http://127.0.0.1:8000",
	SUPABASE_SECRET_KEY: "sb_secret_test",
};
const saved = Object.fromEntries(Object.keys(ENV).map((k) => [k, process.env[k]]));

/** A tiny fake GoTrue: POST creates, PUT resets, GET lists. */
function fakeGoTrue(options: { existing?: string[] } = {}) {
	const users = [...(options.existing ?? [])].map((email, i) => ({ id: `id-${i}`, email }));
	const calls: { method: string; url: string; body?: unknown }[] = [];
	mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		const body = init?.body ? JSON.parse(String(init.body)) : undefined;
		calls.push({ method: init?.method ?? "GET", url, body });
		if (url.endsWith("/auth/v1/admin/users") && init?.method === "POST") {
			const email = (body as { email: string }).email;
			if (users.some((u) => u.email === email)) {
				return Response.json({ error_code: "email_exists", msg: "A user with this email address has already been registered" }, { status: 422 });
			}
			const user = { id: `id-${users.length}`, email };
			users.push(user);
			return Response.json(user, { status: 200 });
		}
		if (url.includes("/auth/v1/admin/users/") && init?.method === "PUT") {
			return Response.json({ ok: true }, { status: 200 });
		}
		if (url.includes("/auth/v1/admin/users") && (init?.method ?? "GET") === "GET") {
			return Response.json({ users }, { status: 200 });
		}
		return Response.json({ msg: "unexpected" }, { status: 500 });
	});
	return { users, calls };
}

beforeEach(() => {
	Object.assign(process.env, ENV);
	fs.rmSync(path.join(dataDir, "issued-credentials.json"), { force: true });
});
afterEach(() => {
	mock.restoreAll();
	for (const [key, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

describe("password generation", () => {
	it("is long, shell-safe and unique", () => {
		const seen = new Set<string>();
		for (let i = 0; i < 50; i++) {
			const password = generatePassword();
			assert.equal(password.length, 14);
			assert.match(password, /^[A-Za-z0-9]+$/, password);
			seen.add(password);
		}
		assert.equal(seen.size, 50, "no repeats");
	});
});

describe("provisioning availability", () => {
	it("needs a secret key", () => {
		assert.equal(provisioningAvailable(), true);
		delete process.env.SUPABASE_SECRET_KEY;
		assert.equal(provisioningAvailable(), false);
	});

	it("fails honestly with no key", async () => {
		delete process.env.SUPABASE_SECRET_KEY;
		const result = await provisionAccount("a@example.test");
		assert.equal(result.ok, false);
		assert.match(result.ok === false ? result.error : "", /SUPABASE_SECRET_KEY/);
	});
});

describe("provisionAccount", () => {
	it("creates a confirmed account and records the password", async () => {
		const gotrue = fakeGoTrue();
		const result = await provisionAccount("New@Example.test");
		assert.equal(result.ok, true);
		const create = gotrue.calls.find((c) => c.method === "POST");
		assert.equal((create?.body as { email_confirm?: boolean }).email_confirm, true, "must confirm without SMTP");
		assert.equal((create?.body as { email?: string }).email, "new@example.test", "normalised");
		const stored = issuedCredentials();
		assert.equal(stored.length, 1);
		assert.equal(stored[0]!.email, "new@example.test");
		assert.equal(stored[0]!.password, result.ok ? result.credential.password : "");
	});

	it("resets the password when the account already exists", async () => {
		const gotrue = fakeGoTrue({ existing: ["old@example.test"] });
		const result = await provisionAccount("old@example.test");
		assert.equal(result.ok, true);
		assert.equal(result.ok && result.credential.userId, "id-0");
		assert.ok(gotrue.calls.some((c) => c.method === "PUT" && c.url.includes("id-0")), "reset issued");
	});

	it("replaces a prior record rather than duplicating it", async () => {
		fakeGoTrue();
		await provisionAccount("dup@example.test");
		await provisionAccount("dup@example.test");
		assert.equal(issuedCredentials().length, 1);
	});

	it("rejects an unusable address without calling out", async () => {
		const gotrue = fakeGoTrue();
		const result = await provisionAccount("nope");
		assert.equal(result.ok, false);
		assert.equal(gotrue.calls.length, 0);
	});

	it("reports a GoTrue failure instead of pretending success", async () => {
		mock.method(globalThis, "fetch", async () => Response.json({ msg: "boom" }, { status: 500 }));
		const result = await provisionAccount("a@example.test");
		assert.equal(result.ok, false);
		assert.match(result.ok === false ? result.error : "", /boom/);
	});

	it("survives an unreachable GoTrue", async () => {
		mock.method(globalThis, "fetch", async () => { throw new Error("ECONNREFUSED"); });
		const result = await provisionAccount("a@example.test");
		assert.equal(result.ok, false);
		assert.match(result.ok === false ? result.error : "", /unreachable/i);
	});

	it("writes the credential file 0600 (it holds live passwords)", async () => {
		if (process.platform === "win32") return;
		fakeGoTrue();
		await provisionAccount("a@example.test");
		const mode = fs.statSync(path.join(dataDir, "issued-credentials.json")).mode & 0o777;
		assert.equal(mode, 0o600);
	});
});

describe("forgetIssued", () => {
	it("drops one address and keeps the rest", async () => {
		fakeGoTrue();
		await provisionAccount("a@example.test");
		await provisionAccount("b@example.test");
		forgetIssued("a@example.test");
		assert.deepEqual(issuedCredentials().map((c) => c.email), ["b@example.test"]);
	});
});