import assert from "node:assert/strict";
import { after, afterEach, beforeEach, it, mock } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-approval-email-"));
process.env.LH_DATA_DIR = dataDir;
const { approveAccount, sendApprovalEmail } = await import("../src/server/approval-email.ts");
const { issuedCredentials, recordIssued, forgetIssued } = await import("../src/core/hosted-credentials.ts");
const { admittedEmails, requestSignup, pendingSignups } = await import("../src/core/hosted-admission.ts");
const env = {
	HOSTED_MODE: "on",
	DATABASE_URL: "postgresql://unused",
	BETTER_AUTH_SECRET: "secret",
	RESEND_API_KEY: "resend-test",
	RESEND_FROM: "UPsolve <noreply@upsolve.study>",
	APP_ORIGIN: "https://learn.upsolve.study",
};
const credential = {
	email: "learner@example.test", password: "OriginalPassword123", userId: "user-1", issuedAt: "2026-11-21T00:00:00.000Z",
};
const goodProvision = async () => ({ ok: true as const, userId: "user-1" });

beforeEach(() => {
	for (const file of ["issued-credentials.json", "admissions.json", "signups.json"]) {
		fs.rmSync(path.join(dataDir, file), { force: true });
	}
});
afterEach(() => mock.restoreAll());
after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

it("approval creates the account before emailing the exact generated credentials", async () => {
	requestSignup("Learner@Example.test");
	const calls: string[] = [];
	let password = "";
	const provision = async (email: string, generated: string) => {
		assert.equal(email, credential.email);
		password = generated;
		return { ok: true as const, userId: "user-1" };
	};
	mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		calls.push(url);
		assert.equal(url, "https://api.resend.com/emails", "provisioning must not use the network in this test");
		const body = JSON.parse(String(init?.body));
		assert.deepEqual(body.to, [credential.email]);
		assert.equal(body.from, env.RESEND_FROM);
		assert.equal(body.subject, "Your UPsolve Learn account is ready");
		assert.ok(body.text.includes(`Password: ${password}`));
		assert.ok(body.text.includes("Sign in: https://learn.upsolve.study/auth/login"));
		assert.equal(new Headers(init?.headers).get("authorization"), "Bearer resend-test");
		assert.equal(init?.redirect, "error");
		assert.ok(init?.signal);
		return Response.json({ id: "email-1" });
	});
	const result = await approveAccount("Learner@Example.test", env, provision);
	assert.ok(result.ok);
	assert.equal(calls.length, 1, "only the email request");
	assert.ok(admittedEmails().includes(credential.email));
	assert.equal(pendingSignups().length, 0);
	assert.equal(issuedCredentials()[0]!.password, password);
	assert.equal(issuedCredentials()[0]!.emailDelivery?.status, "accepted");
	// A stale repeat of the Approve form neither resets the password nor sends twice.
	await approveAccount(credential.email, env, provision);
	assert.equal(calls.length, 1);
});

it("provisioning failure sends no email and reports failure", async () => {
	const fetch = mock.method(globalThis, "fetch", async () => { throw new Error("Must not send"); });
	const result = await approveAccount(credential.email, env, async () => ({ ok: false as const, error: "db down" }));
	assert.equal(result.ok, false);
	assert.equal(result.ok === false ? result.error : "", "db down");
	assert.equal(fetch.mock.calls.length, 0);
	assert.equal(issuedCredentials().length, 0);
});

it("concurrent approvals share one password and one email", async () => {
	let finish!: (result: { ok: true; userId: string }) => void;
	const provision = async () => new Promise<{ ok: true; userId: string }>(resolve => { finish = resolve; });
	const fetch = mock.method(globalThis, "fetch", async () => Response.json({ id: "one-email" }));
	const first = approveAccount(credential.email, env, provision);
	const second = approveAccount(credential.email, env, provision);
	finish({ ok: true, userId: "user-1" });
	const results = await Promise.all([first, second]);
	assert.deepEqual(results[0], results[1]);
	assert.equal(fetch.mock.calls.length, 1);
});

it("timeout and retry keep the password and request identity, without provisioning again", async () => {
	recordIssued(credential);
	const requests: { key: string | null; body: unknown }[] = [];
	mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
		assert.equal(String(input), "https://api.resend.com/emails");
		requests.push({ key: new Headers(init?.headers).get("Idempotency-Key"), body: init?.body });
		if (requests.length === 1) throw new Error(`Network error containing ${env.RESEND_API_KEY}`);
		return Response.json({ id: "email-retry" });
	});
	assert.equal((await sendApprovalEmail(credential.email, env)).status, "failed");
	assert.equal(issuedCredentials()[0]!.password, credential.password);
	assert.equal((await sendApprovalEmail(credential.email, env)).status, "accepted");
	assert.deepEqual(requests[0], requests[1]);
	assert.match(requests[0]!.key!, /^approval\/[a-f0-9]{64}$/);
	assert.ok(!requests[0]!.key!.includes(credential.password));
	await sendApprovalEmail(credential.email, env);
	assert.equal(requests.length, 2, "stored acceptance suppresses further sends");
});

for (const status of [401, 403, 429, 500]) {
	it(`HTTP ${status} is a retryable failure without storing provider secrets`, async () => {
		recordIssued(credential);
		mock.method(globalThis, "fetch", async () => Response.json({ message: `${env.RESEND_API_KEY} ${credential.password}` }, { status }));
		const result = await sendApprovalEmail(credential.email, env);
		assert.equal(result.status, "failed");
		assert.ok(!JSON.stringify(result).includes(env.RESEND_API_KEY));
		assert.ok(!JSON.stringify(result).includes(credential.password));
		assert.deepEqual(issuedCredentials()[0]!.emailDelivery, result);
	});
}

it("missing key and invalid login origin fail without sending", async () => {
	recordIssued(credential);
	const fetch = mock.method(globalThis, "fetch", async () => { throw new Error("Must not send"); });
	assert.equal((await sendApprovalEmail(credential.email, { ...env, RESEND_API_KEY: "" })).status, "failed");
	assert.equal((await sendApprovalEmail(credential.email, { ...env, APP_ORIGIN: "http://localhost:3000" })).status, "failed");
	assert.equal(fetch.mock.calls.length, 0);
});

it("invalid or unknown addresses cannot send a credential email", async () => {
	recordIssued(credential);
	const fetch = mock.method(globalThis, "fetch", async () => { throw new Error("Must not send"); });
	assert.equal((await approveAccount("invalid", env, goodProvision)).ok, false);
	assert.equal((await sendApprovalEmail("unknown@example.test", env)).status, "failed");
	assert.equal(fetch.mock.calls.length, 0);
});

it("a successful HTTP response needs a valid email id before recording acceptance", async () => {
	recordIssued(credential);
	mock.method(globalThis, "fetch", async () => Response.json({}));
	assert.equal((await sendApprovalEmail(credential.email, env)).status, "failed");
});

for (const change of ["reset", "forget"] as const) {
	it(`a delayed email completion cannot undo a credential ${change}`, async () => {
		recordIssued(credential);
		let finish!: (response: Response) => void;
		mock.method(globalThis, "fetch", () => new Promise<Response>(resolve => { finish = resolve; }));
		const pending = sendApprovalEmail(credential.email, env);
		if (change === "reset") recordIssued({ ...credential, password: "ReplacementPassword" });
		else forgetIssued(credential.email);
		finish(Response.json({ id: "old-email" }));
		await pending;
		if (change === "reset") {
			assert.equal(issuedCredentials()[0]!.password, "ReplacementPassword");
			assert.equal(issuedCredentials()[0]!.emailDelivery, undefined);
		} else assert.equal(issuedCredentials().length, 0);
	});
}

it("a concurrent failed retry cannot overwrite accepted status", async () => {
	recordIssued(credential);
	const finish: ((response: Response) => void)[] = [];
	mock.method(globalThis, "fetch", () => new Promise<Response>(resolve => { finish.push(resolve); }));
	const first = sendApprovalEmail(credential.email, env);
	const second = sendApprovalEmail(credential.email, env);
	finish[0]!(Response.json({ id: "email-1" }));
	await first;
	finish[1]!(Response.json({}, { status: 409 }));
	await second;
	assert.equal(issuedCredentials()[0]!.emailDelivery?.status, "accepted");
});
