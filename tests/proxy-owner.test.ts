import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach, mock } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-proxy-owner-"));
process.env.LH_DATA_DIR = dataDir;

const { proxy } = await import("../proxy.ts");
const { NextRequest } = await import("next/server");

const OWNER = "9d0409ac-ee31-4944-8cc8-56ef5eb1bed5";
const origin = "http://localhost";
const saved = Object.fromEntries(["HOSTED_MODE", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "SUPABASE_DB_URL", "HOSTED_PILOT_EMAIL"].map((k) => [k, process.env[k]]));

function setUp(admitted: string[]) {
	Object.assign(process.env, {
		HOSTED_MODE: "on",
		NEXT_PUBLIC_SUPABASE_URL: "https://supabase.invalid",
		NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
		SUPABASE_DB_URL: "postgresql://unused",
		HOSTED_PILOT_EMAIL: undefined,
	});
	fs.writeFileSync(path.join(dataDir, "admissions.json"), JSON.stringify({ version: 1, emails: admitted }));
}

/** The cookie @supabase/ssr reads a session from, shaped as it expects. */
function sessionCookie(email: string, id = OWNER): string {
	const session = { access_token: "t", refresh_token: "t", expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id, email } };
	return `sb-supabase-auth-token=base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`;
}

/** getUser() round-trips to GoTrue; answer it with the same verified user. */
function mockGoTrue(email: string, id = OWNER) {
	return mock.method(globalThis, "fetch", async () => Response.json({ id, email }));
}

beforeEach(() => { fs.rmSync(path.join(dataDir, "admissions.json"), { force: true }); });
afterEach(() => {
	mock.restoreAll();
	for (const [key, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

describe("Proxy owner forwarding", () => {
	it("forwards the verified id for an admitted account", async (t) => {
		setUp(["invited@example.test"]);
		mockGoTrue("invited@example.test");
		const response = await proxy(new NextRequest(new URL("/", origin), { headers: { cookie: sessionCookie("invited@example.test") } }));
		assert.equal(response.status, 200);
		assert.equal(response.headers.get("x-middleware-override-headers")?.includes("x-lh-owner"), true);
	});

	it("does not forward an owner for a signed-in but unadmitted account", async () => {
		setUp([]);
		mockGoTrue("stranger@example.test");
		const response = await proxy(new NextRequest(new URL("/", origin), { headers: { cookie: sessionCookie("stranger@example.test") } }));
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

	it("overwrites a client-supplied owner header rather than trusting it", async (t) => {
		setUp(["invited@example.test"]);
		mockGoTrue("invited@example.test");
		const spoof = "0f0e0d0c-0b0a-4908-8706-050403020100";
		const response = await proxy(new NextRequest(new URL("/", origin), {
			headers: { cookie: sessionCookie("invited@example.test"), "x-lh-owner": spoof },
		}));
		// Next forwards overridden headers as a JSON map on this internal header.
		const overrides = response.headers.get("x-middleware-request-x-lh-owner");
		assert.equal(overrides, OWNER, "the verified id wins over the spoof");
	});
});