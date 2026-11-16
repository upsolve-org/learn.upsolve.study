import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// config.ts resolves LH_DATA_DIR at MODULE LOAD, and static imports are
// hoisted above any assignment here — so every import that can reach config.ts
// is dynamic, after the root is set. One root for the file; each case clears
// the two files it owns.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-admission-"));
process.env.LH_DATA_DIR = dataDir;

const { proxy } = await import("../proxy.ts");
const { NextRequest } = await import("next/server");
const { createPluginDocumentRoute } = await import("../src/server/plugin-transport.ts");
const {
	pilotUserAllowed, admittedUser, admittedEmails, normalizeEmail, isOperator,
	pendingSignups, requestSignup, approveSignup, denySignup,
} = await import("../src/core/hosted-admission.ts");

const ID = "9d0409ac-ee31-4944-8cc8-56ef5eb1bed5";
let saved: Record<string, string | undefined>;

function env(overrides: Record<string, string | undefined> = {}) {
	const base: Record<string, string | undefined> = {
		HOSTED_MODE: "on",
		NEXT_PUBLIC_SUPABASE_URL: "https://supabase.invalid",
		NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "test",
		SUPABASE_DB_URL: "postgresql://unused",
		HOSTED_PILOT_EMAIL: undefined,
		ADMIN_EMAIL: undefined,
		LH_DATA_DIR: dataDir,
	};
	for (const [k, v] of Object.entries(base)) {
		if (k in overrides) continue;
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	for (const [k, v] of Object.entries(overrides)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
}

function writeAdmissions(emails: string[]) {
	fs.writeFileSync(path.join(dataDir, "admissions.json"), JSON.stringify({ version: 1, emails }));
}

beforeEach(() => {
	fs.rmSync(path.join(dataDir, "admissions.json"), { force: true });
	fs.rmSync(path.join(dataDir, "signups.json"), { force: true });
	saved = Object.fromEntries(["HOSTED_MODE", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "SUPABASE_DB_URL", "HOSTED_PILOT_EMAIL", "ADMIN_EMAIL", "LH_DATA_DIR"].map((k) => [k, process.env[k]]));
	env();
});

afterEach(() => {
	for (const [key, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

describe("admission", () => {
	it("fails closed with no allowlist and no pilot email", () => {
		assert.deepEqual(admittedEmails(), []);
		assert.equal(admittedUser({ id: ID, email: "invited@example.test" }), false);
	});

	it("admits only listed addresses, case-insensitively", () => {
		writeAdmissions(["invited@example.test"]);
		assert.equal(admittedUser({ id: ID, email: "Invited@Example.Test" }), true);
		assert.equal(admittedUser({ id: ID, email: "other@example.test" }), false);
	});

	it("still honours HOSTED_PILOT_EMAIL as an implicit entry", () => {
		env({ HOSTED_PILOT_EMAIL: "pilot@example.test" });
		assert.deepEqual(admittedEmails(), ["pilot@example.test"]);
		assert.equal(pilotUserAllowed({ id: ID, email: "pilot@example.test" }), true);
	});

	it("requires a usable subject id, not just an email", () => {
		writeAdmissions(["invited@example.test"]);
		for (const id of ["", "../../data", "not-a-uuid"]) {
			assert.equal(admittedUser({ id, email: "invited@example.test" }), false, id);
		}
	});

	it("treats a corrupt allowlist as empty rather than open", () => {
		fs.writeFileSync(path.join(dataDir, "admissions.json"), "{not json");
		assert.deepEqual(admittedEmails(), []);
	});

	it("normalises and rejects junk addresses", () => {
		assert.equal(normalizeEmail("  A@B.CO "), "a@b.co");
		for (const bad of [undefined, null, 42, "", "no-at", "a@b", "a b@c.de"]) {
			assert.equal(normalizeEmail(bad), undefined, String(bad));
		}
	});
});

describe("signup queue", () => {
	// REGRESSION (found in the 2026-11-16 deployment): the files were written
	// 0600. The operator approves as root over SSH, but the SERVER reads them
	// as its own user — so admission failed closed with no visible error and
	// every learner was refused. Group/other read is required.
	it("writes files readable by the server user, not just the writer", () => {
		if (process.platform === "win32") return; // no POSIX mode bits
		requestSignup("mode@example.test");
		approveSignup("mode@example.test");
		for (const name of ["signups.json", "admissions.json"]) {
			const mode = fs.statSync(path.join(dataDir, name)).mode & 0o777;
			assert.equal(mode & 0o044, 0o044, `${name} must be group/other readable, got ${mode.toString(8)}`);
		}
	});

	it("queues once and is idempotent", () => {
		assert.equal(requestSignup("New@Example.test"), "queued");
		assert.equal(requestSignup("new@example.test"), "already-pending");
		assert.deepEqual(pendingSignups().map((r) => r.email), ["new@example.test"]);
	});

	it("reports an already-admitted address instead of queueing it", () => {
		writeAdmissions(["in@example.test"]);
		assert.equal(requestSignup("in@example.test"), "already-admitted");
		assert.deepEqual(pendingSignups(), []);
	});

	it("rejects an unusable address without writing", () => {
		assert.equal(requestSignup("nope"), undefined);
		assert.deepEqual(pendingSignups(), []);
	});

	it("approve admits and clears the request; deny only clears", () => {
		requestSignup("a@example.test");
		requestSignup("b@example.test");
		assert.equal(approveSignup("a@example.test"), true);
		assert.equal(denySignup("b@example.test"), true);
		assert.deepEqual(admittedEmails(), ["a@example.test"]);
		assert.deepEqual(pendingSignups(), []);
	});

	it("approving twice does not duplicate the allowlist entry", () => {
		requestSignup("a@example.test");
		approveSignup("a@example.test");
		approveSignup("a@example.test");
		assert.deepEqual(admittedEmails(), ["a@example.test"]);
	});
});

describe("operator", () => {
	it("is only the configured ADMIN_EMAIL", () => {
		assert.equal(isOperator("op@example.test", {}), false, "unset operator admits nobody");
		assert.equal(isOperator("op@example.test", { ADMIN_EMAIL: "op@example.test" }), true);
		assert.equal(isOperator("OP@Example.test", { ADMIN_EMAIL: "op@example.test" }), true);
		assert.equal(isOperator("other@example.test", { ADMIN_EMAIL: "op@example.test" }), false);
	});
});

it("anonymous API and Proxy-exempt upload requests cannot touch learner data", async () => {
	assert.equal((await proxy(new NextRequest("http://localhost/api/chats"))).status, 401);
	const route = createPluginDocumentRoute({ convertDocument: async () => { throw new Error("Must not dispatch"); } });
	const response = await route.POST(new Request("http://localhost/api/plugins/flashcards/documents/markdown", { method: "POST" }), { get params(): Promise<{id: string}> { throw new Error("Must not resolve params"); } });
	assert.equal(response.status, 401);
});