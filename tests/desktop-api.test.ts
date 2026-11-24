import assert from "node:assert/strict";
import "./support/async-local-storage.ts";
import { test } from "node:test";
import { createRequire } from "node:module";
import { NextRequest } from "next/server";
// Installed Next 16.3.2 retains the old test-helper export despite proxy.md's new name.
import { unstable_doesMiddlewareMatch as unstable_doesProxyMatch } from "next/experimental/testing/server";
import { desktopAPIAuthorized } from "../src/server/desktop-access.ts";
import { proxy, config } from "../proxy.ts";
const require = createRequire(import.meta.url);
const { HEADER } = require("../src/server/subscription-core/desktop-api.cjs");
const { chatGPTControl } = require("../src/server/subscription-core/chatgpt-ipc.cjs");
const secret = "a".repeat(64);
const origin = "http://127.0.0.1:12345";

test("all methods fail closed for desktop missing/wrong secret; API-only matcher covers SSE/settings/spending", async () => {
	assert(desktopAPIAuthorized(new Headers(), {}), "browser-only API-key mode unchanged");
	assert(!desktopAPIAuthorized(new Headers({ [HEADER]: secret }), { LH_DESKTOP_SERVER: "1" }), "missing server secret must not disable authorization");
	for (const value of [undefined, "", "wrong", secret + ", " + secret]) {
		assert(!desktopAPIAuthorized(new Headers(value === undefined ? {} : { [HEADER]: value }), { LH_DESKTOP_SERVER: "1", LH_DESKTOP_API_SECRET: secret }));
	}
	assert(desktopAPIAuthorized(new Headers({ [HEADER]: secret }), { LH_DESKTOP_SERVER: "1", LH_DESKTOP_API_SECRET: secret }));
	// The matcher now covers pages too (hosted mode needs the session gate);
	// the API refusal itself still applies to every /api path.
	for (const pathname of ["/api/events", "/api/chat", "/api/settings/models", "/api/chats/scratch/markdown", "/chat/new", "/"]) assert(unstable_doesProxyMatch({ config, nextConfig: {}, url: origin + pathname }));
	const originalMarker = process.env.LH_DESKTOP_SERVER;
	const originalSecret = process.env.LH_DESKTOP_API_SECRET;
	const originalHosted = process.env.HOSTED_MODE;
	try {
		process.env.LH_DESKTOP_SERVER = "1";
		process.env.LH_DESKTOP_API_SECRET = secret;
		delete process.env.HOSTED_MODE;
		for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
			assert.equal((await proxy(new NextRequest(origin + "/api/settings", { method }))).status, 403);
			assert.equal((await proxy(new NextRequest(origin + "/api/settings", { method, headers: { [HEADER]: secret } }))).headers.get("x-middleware-next"), "1");
		}
	} finally {
		if (originalMarker === undefined) delete process.env.LH_DESKTOP_SERVER; else process.env.LH_DESKTOP_SERVER = originalMarker;
		if (originalSecret === undefined) delete process.env.LH_DESKTOP_API_SECRET; else process.env.LH_DESKTOP_API_SECRET = originalSecret;
		if (originalHosted === undefined) delete process.env.HOSTED_MODE; else process.env.HOSTED_MODE = originalHosted;
	}
});

test("renderer controls route explicit account forgetting and account-independent boolean consent only", async () => {
	const forgotten: string[] = [], changes: boolean[] = [];
	const connection = { disconnect: async (id: string) => { forgotten.push(id); return { ok: true }; }, consent: async (enabled: boolean) => { changes.push(enabled); return { ok: true }; } };
	assert.deepEqual(await chatGPTControl({ op: "disconnect", id: "fixture-account" }, connection), { ok: true });
	assert.deepEqual(await chatGPTControl({ op: "consent", enabled: false }, connection), { ok: true });
	assert.deepEqual(forgotten, ["fixture-account"]); assert.deepEqual(changes, [false]);
	for (const command of [{ op: "disconnect" }, { op: "disconnect", id: 7 }, { op: "consent", enabled: "false" }]) assert.deepEqual(await chatGPTControl(command, connection), { error: "Unsupported ChatGPT control." });
	assert.deepEqual(changes, [false]);
});

test("renderer controls have no lease or general token bridge", async () => {
	let leased = false;
	const connection = { lease: async () => { leased = true; return { accessToken: "scratch-private-token" }; } };
	assert.deepEqual(await chatGPTControl({ op: "lease", background: false }, connection), { error: "Unsupported ChatGPT control." });
	assert.equal(leased, false);
});