import assert from "node:assert/strict";
import { it } from "node:test";
import { hostedFetch } from "../src/core/hosted-fetch.ts";

it("routes server auth to loopback without changing the public SDK identity", async () => {
	let seen = "";
	const transport: typeof fetch = async (url, init) => {
		seen = String(url);
		assert.equal(init?.redirect, "error");
		assert.ok(init?.signal);
		assert.equal(new Headers(init?.headers).get("apikey"), "test");
		return new Response("{}");
	};
	await hostedFetch("https://learn.upsolve.study", "http://127.0.0.1:8000", transport)("https://learn.upsolve.study/auth/v1/settings", { headers: { apikey: "test" } });
	assert.equal(seen, "http://127.0.0.1:8000/auth/v1/settings");
});

it("preserves request method, body and cancellation when rewriting", async () => {
	const controller = new AbortController();
	const transport: typeof fetch = async (input, init) => {
		assert.ok(input instanceof Request);
		assert.equal(input.url, "http://127.0.0.1:8000/auth/v1/token");
		assert.equal(input.method, "POST");
		assert.equal(await input.text(), "body");
		controller.abort();
		assert.equal(init?.signal?.aborted, true);
		return new Response("{}");
	};
	await hostedFetch("https://learn.upsolve.study", "http://127.0.0.1:8000", transport)(new Request("https://learn.upsolve.study/auth/v1/token", { method: "POST", body: "body", signal: controller.signal }));
});
