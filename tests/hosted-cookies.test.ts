import assert from "node:assert/strict";
import { it } from "node:test";
import { cookieWrites } from "../src/core/hosted-cookies.ts";

it("does not duplicate Next continuation headers on the same response", () => {
	const response = new Response(null, { headers: { "x-middleware-next": "1" } });
	const jar = cookieWrites();
	jar.setAll([{ name: "session.0", value: "token", options: { httpOnly: true, secure: true, maxAge: 60, path: "/" } }]);
	jar.landOn(response, response);
	assert.equal(response.headers.get("x-middleware-next"), "1");
	assert.equal(response.headers.getSetCookie().length, 1);
	assert.match(response.headers.getSetCookie()[0]!, /Max-Age=60/);
	assert.match(response.headers.getSetCookie()[0]!, /; HttpOnly(?:;|$)/);
});

it("redirects retain separate refresh cookies without middleware control headers", () => {
	const upstream = new Response(null, { headers: { "x-middleware-next": "1", "x-middleware-request-cookie": "private" } });
	const redirect = new Response(null, { status: 307, headers: { location: "/auth/login" } });
	const jar = cookieWrites();
	jar.setAll([{ name: "session.0", value: "", options: { maxAge: 0, path: "/" } }, { name: "session.1", value: "", options: { maxAge: 0, path: "/" } }]);
	jar.landOn(upstream, redirect);
	assert.equal(redirect.headers.get("x-middleware-next"), null);
	assert.equal(redirect.headers.get("x-middleware-request-cookie"), null);
	assert.equal(redirect.headers.getSetCookie().length, 2);
	assert.equal(redirect.headers.get("location"), "/auth/login");
});
