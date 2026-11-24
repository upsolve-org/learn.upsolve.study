import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-proxy-owner-"));
process.env.LH_DATA_DIR = dataDir;

const { proxy } = await import("../proxy.ts");
const { NextRequest } = await import("next/server");
const { setAuthSessionResolver } = await import("../src/server/auth.ts");

const OWNER = "9d0409ac-ee31-4944-8cc8-56ef5eb1bed5";
const origin = "http://localhost";
const saved = Object.fromEntries(
	["HOSTED_MODE", "DATABASE_URL", "BETTER_AUTH_SECRET", "HOSTED_PILOT_EMAIL"].map((k) => [k, process.env[k]]),
);

/** The test seam replaces the live Better Auth session lookup. */
let current: { id: string; email: string } | null = null;
setAuthSessionResolver(async () => current);

function setUp(admitted: string[]) {
	Object.assign(process.env, {
		HOSTED_MODE: "on",
		DATABASE_URL: "postgresql://unused",
		BETTER_AUTH_SECRET: "secret",
		HOSTED_PILOT_EMAIL: undefined,
	});
	fs.writeFileSync(path.join(dataDir, "admissions.json"), JSON.stringify({ version: 1, emails: admitted }));
}

beforeEach(() => { current = null; fs.rmSync(path.join(dataDir, "admissions.json"), { force: true }); });
afterEach(() => {
	for (const [key, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

describe("Proxy owner forwarding", () => {
	it("forwards the verified id for an admitted account", async () => {
		setUp(["invited@example.test"]);
		current = { id: OWNER, email: "invited@example.test" };
		const response = await proxy(new NextRequest(new URL("/", origin)));
		assert.equal(response.status, 200);
		assert.equal(response.headers.get("x-middleware-override-headers")?.includes("x-lh-owner"), true);
	});

	it("does not forward an owner for a signed-in but unadmitted account", async () => {
		setUp([]);
		current = { id: OWNER, email: "stranger@example.test" };
		const response = await proxy(new NextRequest(new URL("/", origin)));
		assert.equal(response.status, 307);
		assert.equal(response.headers.get("location"), `${origin}/auth/denied`);
	});

	it("redirects a signed-out visitor to sign-in", async () => {
		setUp([]);
		const response = await proxy(new NextRequest(new URL("/", origin)));
		assert.equal(response.status, 307);
		assert.match(response.headers.get("location") ?? "", /\/auth\/login/);
	});

	it("lets the public signup and denied pages through without a session", async () => {
		setUp([]);
		for (const page of ["/auth/signup", "/auth/denied"]) {
			const response = await proxy(new NextRequest(new URL(page, origin)));
			assert.equal(response.status, 200, page);
		}
	});

	it("overwrites a client-supplied owner header rather than trusting it", async () => {
		setUp(["invited@example.test"]);
		current = { id: OWNER, email: "invited@example.test" };
		const spoof = "0f0e0d0c-0b0a-4908-8706-050403020100";
		const response = await proxy(new NextRequest(new URL("/", origin), {
			headers: { "x-lh-owner": spoof, "x-lh-operator": "1" },
		}));
		// Next forwards overridden headers as a plain value on this internal header.
		assert.equal(response.headers.get("x-middleware-request-x-lh-owner"), OWNER, "the verified id wins over the spoof");
		assert.equal(response.headers.get("x-middleware-request-x-lh-operator"), null, "no operator for a learner");
	});
});
