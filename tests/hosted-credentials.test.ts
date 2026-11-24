import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// config.ts resolves LH_DATA_DIR at module load; the imports below are dynamic.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-credentials-"));
process.env.LH_DATA_DIR = dataDir;

const {
	provisionAccount, issuedCredentials, forgetIssued, provisioningAvailable, generatePassword,
} = await import("../src/core/hosted-credentials.ts");
type AccountProvisioner = import("../src/core/hosted-credentials.ts").AccountProvisioner;

const ENV = {
	HOSTED_MODE: "on",
	DATABASE_URL: "postgresql://unused",
	BETTER_AUTH_SECRET: "secret",
};
const saved = Object.fromEntries(Object.keys(ENV).map((k) => [k, process.env[k]]));

/** The server-side write is injected: no database in these unit tests. */
const calls: { email: string; password: string }[] = [];
const provisioner: AccountProvisioner = async (email, password) => {
	calls.push({ email, password });
	return { ok: true, userId: "user-from-db" };
};

beforeEach(() => {
	Object.assign(process.env, ENV);
	calls.length = 0;
	fs.rmSync(path.join(dataDir, "issued-credentials.json"), { force: true });
});
afterEach(() => {
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
	it("needs hosted mode and a database URL", () => {
		assert.equal(provisioningAvailable(), true);
		delete process.env.DATABASE_URL;
		assert.equal(provisioningAvailable(), false);
		process.env.DATABASE_URL = ENV.DATABASE_URL;
		delete process.env.HOSTED_MODE;
		assert.equal(provisioningAvailable(), false);
	});

	it("fails honestly with no provisioner", async () => {
		const result = await provisionAccount("a@example.test");
		assert.equal(result.ok, false);
		assert.match(result.ok === false ? result.error : "", /DATABASE_URL/);
		assert.equal(calls.length, 0);
	});
});

describe("provisionAccount", () => {
	it("creates a confirmed account and records the exact password", async () => {
		const result = await provisionAccount("New@Example.test", process.env, provisioner);
		assert.equal(result.ok, true);
		assert.equal(calls.length, 1);
		assert.equal(calls[0]!.email, "new@example.test", "normalised");
		assert.ok(calls[0]!.password.length >= 14);
		const stored = issuedCredentials();
		assert.equal(stored.length, 1);
		assert.equal(stored[0]!.email, "new@example.test");
		assert.equal(stored[0]!.password, calls[0]!.password);
		assert.equal(stored[0]!.userId, "user-from-db");
		assert.ok(!Number.isNaN(Date.parse(stored[0]!.issuedAt)));
	});

	it("keeps the existing user id returned by the provisioner", async () => {
		const result = await provisionAccount("old@example.test", process.env, async () => ({ ok: true, userId: "existing-id" }));
		assert.equal(result.ok && result.credential.userId, "existing-id");
	});

	it("replaces a prior record rather than duplicating it", async () => {
		await provisionAccount("dup@example.test", process.env, provisioner);
		await provisionAccount("dup@example.test", process.env, provisioner);
		assert.equal(issuedCredentials().length, 1);
		assert.equal(calls.length, 2, "each approval resets the password");
	});

	it("rejects an unusable address without calling out", async () => {
		const result = await provisionAccount("nope", process.env, provisioner);
		assert.equal(result.ok, false);
		assert.equal(calls.length, 0);
	});

	it("reports a provisioner failure instead of pretending success", async () => {
		const result = await provisionAccount("a@example.test", process.env, async () => ({ ok: false, error: "db down" }));
		assert.equal(result.ok, false);
		assert.equal(result.ok === false ? result.error : "", "db down");
		assert.equal(issuedCredentials().length, 0);
	});

	it("survives a throwing provisioner", async () => {
		const result = await provisionAccount("a@example.test", process.env, async () => { throw new Error("connection string"); });
		assert.equal(result.ok, false);
		assert.match(result.ok === false ? result.error : "", /provisioning failed/i);
		assert.ok(!JSON.stringify(result).includes("connection string"));
		assert.equal(issuedCredentials().length, 0);
	});

	it("writes the credential file 0600 (it holds live passwords)", async () => {
		if (process.platform === "win32") return;
		await provisionAccount("a@example.test", process.env, provisioner);
		const mode = fs.statSync(path.join(dataDir, "issued-credentials.json")).mode & 0o777;
		assert.equal(mode, 0o600);
	});
});

describe("forgetIssued", () => {
	it("drops one address and keeps the rest", async () => {
		await provisionAccount("a@example.test", process.env, provisioner);
		await provisionAccount("b@example.test", process.env, provisioner);
		forgetIssued("a@example.test");
		assert.deepEqual(issuedCredentials().map((c) => c.email), ["b@example.test"]);
	});
});
