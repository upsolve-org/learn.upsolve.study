import assert from "node:assert/strict";
import "./support/async-local-storage.ts";
import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { it } from "node:test";
import { getCloneableBody } from "next/dist/server/body-streams.js";
import { NextRequest } from "next/server";
// Installed Next retains this name for its Proxy matcher test helper.
import { unstable_doesMiddlewareMatch as unstable_doesProxyMatch } from "next/experimental/testing/server";
import { config, proxy } from "../proxy.ts";
import { createPluginDocumentConverter, MAX_DOCUMENT_BODY_BYTES } from "../src/server/plugin-documents.ts";
import { documentEndpointExempt, PROXY_MATCHER } from "../src/core/auth-routes.ts";
import { createPluginDocumentRoute, createPluginTransport } from "../src/server/plugin-transport.ts";
import { setAuthSessionResolver } from "../src/server/auth.ts";

const origin = "http://localhost";
const documentPath = "/api/plugins/document-one/documents/markdown";
const result = { name: "small.txt", markdown: "small valid text 字", notices: [] as string[] };

/** Next's router tests the raw AND decoded pathname with OR semantics.
 *
 * Hosted mode short-circuits the streamed document endpoint before the
 * matcher is consulted (proxy.ts), so this answers for the desktop/browser
 * gate: hosted mode off. The gate EXEMPTS only that exact endpoint; the
 * whitelist below is the matcher's job and is asserted separately. */
function proxyMatches(path: string): boolean {
	const hosted = process.env.HOSTED_MODE;
	delete process.env.HOSTED_MODE;
	try {
		const url = new URL(path, origin);
		const matches = (value: URL) => unstable_doesProxyMatch({ config, nextConfig: {}, url: value.href });
		if (matches(url)) return true;
		try { url.pathname = decodeURIComponent(url.pathname); } catch { /* Next ignores decode errors. */ }
		return matches(url);
	} finally {
		if (hosted === undefined) delete process.env.HOSTED_MODE; else process.env.HOSTED_MODE = hosted;
	}
}

it("Proxy exempts only the exact document endpoint, optional trailing slash and query, including encoded valid IDs", () => {
	for (const path of [
		documentPath, `${documentPath}/`, `${documentPath}?request=1`, `${documentPath}/?request=1`,
		"/api/plugins/document%2Done/documents/markdown", "/api/plugins/%64ocument-one/documents/markdown/",
	]) {
		assert.equal(documentEndpointExempt(new URL(path, origin)), true, path);
	}
	assert.equal(documentEndpointExempt(new URL(`${documentPath}?a=?b`, origin)), true, "a query with its own ?");
	assert.equal(documentEndpointExempt(new URL(`${documentPath}.json`, origin)), false);
	assert.equal(documentEndpointExempt(new URL(`${documentPath}ish`, origin)), false);
	assert.equal(documentEndpointExempt(new URL("/api/plugins/%E0%A4%A/documents/markdown", origin)), false, "bad escape is not excused");
});

it("the matcher covers every page and API route; the runtime exemption is a separate check", () => {
	// The matcher is a plain path regex: it runs on the exempt endpoint too.
	// Only `_next` build output stays outside it.
	for (const path of [
		"/api", "/api/", "/api/plugins", "/api/plugins/document-one/call",
		"/api/plugins/document-one/documents", "/api/plugins/document-one/documents/other",
		`${documentPath}/extra`, "/api/plugins/document-one/other/documents/markdown", "/api/plugins/documents/markdown",
		"/api/graph/import", "/api/events", "/api/chat", "/api/settings/models", "/api/chats/scratch/markdown",
		documentPath, `${documentPath}/`, `${documentPath}?request=1`,
		// Pages and the login flow: all inside the matcher, so the session
		// gate reaches them.
		"/", "/chat/new", "/settings", "/auth/login", "/auth/callback", "/apix",
	]) assert.equal(PROXY_MATCHER.test(new URL(path, origin).pathname), true, path);
	for (const path of ["/_next/static/chunk.js", "/_next/image", "/_next/webpack-hmr"]) {
		assert.equal(PROXY_MATCHER.test(path), false, path);
	}
});

/** Use installed Next's real clone/finalize implementation, not a mock of its
 * truncation. Holding a cloneable-body wrapper alone must leave the stream intact.
 * `hosted` reproduces production: Next clones, the Proxy runs over the clone, the
 * route rebuilds the Request from that body. */
async function uploadThroughNext(path: string, oversized: boolean, mode: { hosted?: boolean; clone?: boolean } = {}, declaredLength?: string) {
	const form = new FormData();
	form.append("file", new File([result.markdown], result.name));
	const sample = new Request(new URL(path, origin), { method: "POST", body: form });
	const prefix = Buffer.from(await sample.arrayBuffer());
	const chunk = Buffer.alloc(64 * 1024, 32); // Legal MIME epilogue after a complete multipart form.
	const chunks: Buffer[] = oversized ? [prefix, ...Array<Buffer>(417).fill(chunk)] : [prefix];
	const actualBytes = chunks.reduce((sum, bytes) => sum + bytes.byteLength, 0);
	const raw = Object.assign(Readable.from(chunks), { url: path }) as IncomingMessage;
	if (declaredLength !== undefined) sample.headers.set("content-length", declaredLength);
	let cloned = mode.clone ?? false;
	if (mode.hosted) {
		const hosted = process.env.HOSTED_MODE;
		process.env.HOSTED_MODE = "on";
		try {
			const nextRequest = new NextRequest(sample.url, { method: "POST", headers: sample.headers, body: raw, duplex: "half" } as never);
			const holder = getCloneableBody(raw, MAX_DOCUMENT_BODY_BYTES);
			cloned = true;
			const clone = holder.cloneBodyStream();
			clone.resume();
			// The Proxy's outcome on the streamed clone is what's under test here.
			await proxy(nextRequest);
			await holder.finalize();
			const incoming = new Request(sample.url, { method: "POST", headers: nextRequest.headers, body: nextRequest.body, duplex: "half" } as never);
			// What the route sees after the Proxy hands the request on.
			return { request: new Request(sample.url, { method: "POST", headers: incoming.headers, body: incoming.body, duplex: "half" } as never), cloned, actualBytes };
		} catch {
			/* An oversized clone is dropped; the original stream must survive. */
		} finally {
			if (hosted === undefined) delete process.env.HOSTED_MODE; else process.env.HOSTED_MODE = hosted;
		}
	} else if (mode.clone ?? proxyMatches(path)) {
		const holder = getCloneableBody(raw, MAX_DOCUMENT_BODY_BYTES);
		holder.cloneBodyStream().resume();
		await holder.finalize();
	}
	const incoming = new Request(sample.url, {
		method: "POST", headers: sample.headers, body: raw, duplex: "half",
	} as unknown as RequestInit);
	// What the route sees after the Proxy hands the request on.
	const request = new Request(sample.url, { method: "POST", headers: incoming.headers, body: incoming.body, duplex: "half" } as never);
	return { request, cloned, actualBytes };
}

it("installed Next forced-clone control demonstrates the previous oversized-epilogue acceptance", async t => {
	const warning = t.mock.method(console, "warn", () => {});
	const { request, actualBytes } = await uploadThroughNext(documentPath, true, { clone: true });
	assert.ok(actualBytes > MAX_DOCUMENT_BODY_BYTES);
	assert.equal(request.headers.has("content-length"), false);
	assert.deepEqual(await createPluginDocumentConverter().convert(request, new AbortController().signal), result);
	assert.equal(warning.mock.callCount(), 1, "Next warns and silently shortens rather than refusing the body");
});

for (const declaredLength of [undefined, "1"]) it(`Proxy-config upload is refused once past the file limit, with ${declaredLength ? "a lying" : "no"} Content-Length`, async () => {
	const { request, actualBytes } = await uploadThroughNext(`${documentPath}/?request=1`, true, { hosted: true }, declaredLength);
	assert.ok(actualBytes > MAX_DOCUMENT_BODY_BYTES);
	assert.equal(request.headers.get("content-length"), declaredLength ?? null);
	await assert.rejects(createPluginDocumentConverter().convert(request, new AbortController().signal), (error: unknown) => {
		// A live stream is bound as it is read, so the Proxy allowance stops it
		// at 26 MiB rather than letting the parse discover the truncation.
		assert.equal((error as { status?: number }).status, 413);
		assert.match((error as Error).message, /26 MiB/);
		return true;
	});
});

it("current Proxy config leaves a valid no-Content-Length multipart document convertible", async () => {
	// Hosted mode: the Proxy skips the exemption here because the session
	// reissues the request, which is exactly what a signed-in upload gets.
	const { request } = await uploadThroughNext(documentPath, false, { hosted: true });
	assert.equal(request.headers.has("content-length"), false);
	assert.deepEqual(await createPluginDocumentConverter().convert(request, new AbortController().signal), result);
});

const methods = ["POST", "GET", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;
const secret = "a".repeat(64);
const capabilityHeader = "x-learnharness-desktop";
const forbidden = { error: "Desktop API access requires the trusted LearnHarness window." };

async function withDesktopEnvironment(marker: string | undefined, capability: string | undefined, run: () => Promise<void>) {
	const beforeMarker = process.env.LH_DESKTOP_SERVER, beforeCapability = process.env.LH_DESKTOP_API_SECRET;
	const beforeHosted = process.env.HOSTED_MODE;
	try {
		// These are the desktop/browser gate's own cases: hosted mode off.
		delete process.env.HOSTED_MODE;
		if (marker === undefined) delete process.env.LH_DESKTOP_SERVER; else process.env.LH_DESKTOP_SERVER = marker;
		if (capability === undefined) delete process.env.LH_DESKTOP_API_SECRET; else process.env.LH_DESKTOP_API_SECRET = capability;
		await run();
	} finally {
		if (beforeMarker === undefined) delete process.env.LH_DESKTOP_SERVER; else process.env.LH_DESKTOP_SERVER = beforeMarker;
		if (beforeCapability === undefined) delete process.env.LH_DESKTOP_API_SECRET; else process.env.LH_DESKTOP_API_SECRET = beforeCapability;
		if (beforeHosted === undefined) delete process.env.HOSTED_MODE; else process.env.HOSTED_MODE = beforeHosted;
	}
}

/** Fail immediately on body access and independently count any internal reads. */
function unreadableRequest(method: typeof methods[number], headers?: HeadersInit) {
	let reads = 0, bodyAccesses = 0;
	const body = new ReadableStream<Uint8Array>({
		pull() { reads++; throw new Error("This method must never read the upload"); },
	}, { highWaterMark: 0 });
	const request = new Request(new URL(documentPath, origin), {
		method, headers, ...(method === "GET" || method === "HEAD" ? {} : { body, duplex: "half" }),
	} as RequestInit);
	Object.defineProperty(request, "body", { get() { bodyAccesses++; throw new Error("This method must never access the body"); } });
	return {
		request,
		assertUntouched() {
			assert.equal(bodyAccesses, 0, `${method}: body accessor`);
			assert.equal(reads, 0, `${method}: stream reads`);
			assert.equal(request.bodyUsed, false, `${method}: bodyUsed`);
		},
	};
}

it("document route authenticates ALL methods before params, transport/getHost, or any body access", async t => {
	const getHost = t.mock.fn(async () => { throw new Error("Authorization must precede host composition"); });
	const transport = createPluginTransport({ getHost, directory: "/unused-document-route-test" });
	const convert = t.mock.method(transport, "convertDocument");
	const route = createPluginDocumentRoute(transport);
	const refusals = [
		{ marker: "1", capability: secret, supplied: undefined },
		{ marker: "1", capability: secret, supplied: "" },
		{ marker: "1", capability: secret, supplied: "wrong" },
		{ marker: "1", capability: secret, supplied: `${secret}, ${secret}` },
		{ marker: "1", capability: undefined, supplied: secret },
		{ marker: "1", capability: "too-short", supplied: "too-short" },
		{ marker: undefined, capability: secret, supplied: undefined },
	];
	for (const { marker, capability, supplied } of refusals) await withDesktopEnvironment(marker, capability, async () => {
		for (const method of methods) {
			const headers: Record<string, string> = supplied === undefined ? {} : { [capabilityHeader]: supplied };
			const upload = unreadableRequest(method, headers);
			let paramsAccesses = 0;
			const context = { get params(): Promise<{ id: string }> { paramsAccesses++; throw new Error("Authorization must precede params"); } };
			const response = method === "POST" ? await route.POST(upload.request, context) : await route[method](upload.request);
			assert.equal(response.status, 403, method);
			assert.equal(response.headers.get("Cache-Control"), "no-store", method);
			assert.deepEqual(await response.json(), forbidden, method);
			const proxyRefusal = await proxy(new NextRequest(new URL("/api/settings", origin), { method, headers }));
			assert.equal(response.status, proxyRefusal.status, `${method}: same existing Proxy policy`);
			assert.deepEqual(await proxyRefusal.json(), forbidden, method);
			assert.equal(paramsAccesses, 0, method);
			upload.assertUntouched();
		}
	});
	assert.equal(convert.mock.callCount(), 0, "no resource operation before authority");
	assert.equal(getHost.mock.callCount(), 0, "no root composition before authority");
});

it("authorized document route methods preserve POST dispatch, empty 405s and OPTIONS 204 with Allow", async t => {
	for (const mode of ["desktop", "browser-only", "secret-without-marker"] as const) {
		await withDesktopEnvironment(mode === "desktop" ? "1" : undefined, mode === "browser-only" ? undefined : secret, async () => {
			const headers: Record<string, string> = mode === "browser-only" ? {} : { [capabilityHeader]: secret };
			const forwarded = Response.json(result, { headers: { "Cache-Control": "no-store" } });
			const convert = t.mock.fn(async (id: string, request: Request) => {
				assert.equal(id, "document-one");
				assert.equal(request, post);
				return forwarded;
			});
			const route = createPluginDocumentRoute({ convertDocument: convert });
			for (const method of methods) {
				if (method === "POST") continue;
				const upload = unreadableRequest(method, headers);
				const response = await route[method](upload.request);
				assert.equal(response.status, method === "OPTIONS" ? 204 : 405, `${mode}: ${method}`);
				if (method === "OPTIONS") assert.equal(response.headers.get("Allow"), "OPTIONS, POST");
				assert.equal(await response.text(), "", `${mode}: ${method}`);
				upload.assertUntouched();
			}
			assert.equal(convert.mock.callCount(), 0, "non-POST methods do not dispatch conversion");
			const form = new FormData(); form.append("file", new File([result.markdown], result.name));
			const post = new Request(new URL(documentPath, origin), { method: "POST", headers, body: form });
			assert.equal(await route.POST(post, { params: Promise.resolve({ id: "document-one" }) }), forwarded);
			assert.equal(convert.mock.callCount(), 1);
			assert.equal(post.bodyUsed, false, "route forwards the original request untouched");
		});
	}
});

it("hosted page gate keeps unrelated cookies out of responses and admits a verified invite", async () => {
	const names = ["HOSTED_PILOT_EMAIL", "HOSTED_MODE", "DATABASE_URL", "BETTER_AUTH_SECRET"];
	const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
	Object.assign(process.env, { HOSTED_PILOT_EMAIL: "invited@example.test", HOSTED_MODE: "on", DATABASE_URL: "postgresql://unused", BETTER_AUTH_SECRET: "secret" });
	let user: { id: string; email: string } | null = null;
	setAuthSessionResolver(async () => user);
	try {
		const signedOut = await proxy(new NextRequest(new URL("/", origin), { headers: { cookie: "unrelated=value" } }));
		assert.equal(signedOut.status, 307);
		assert.equal(signedOut.headers.get("x-middleware-next"), null);
		assert.equal(signedOut.headers.getSetCookie().length, 0);
		const login = await proxy(new NextRequest(new URL("/auth/login", origin)));
		assert.equal(login.headers.get("x-middleware-next"), "1");
		// Only the verified session user, not a cookie claim, admits a page.
		user = { id: "9d0409ac-ee31-4944-8cc8-56ef5eb1bed5", email: "invited@example.test" };
		const signedIn = await proxy(new NextRequest(new URL("/", origin), { headers: { cookie: "unrelated=value" } }));
		assert.equal(signedIn.status, 200);
		assert.equal(signedIn.headers.get("x-middleware-next"), "1");
	} finally {
		setAuthSessionResolver(undefined);
		for (const [name, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[name]; else process.env[name] = value;
		}
	}
});

