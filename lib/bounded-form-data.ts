import { MAX_IMPORT_BODY_BYTES } from "./notes-import-limits.ts";

/** Actual-body bound, independent of absent or untrustworthy Content-Length. */
export class FormBodyLimitError extends Error {}

/**
 * Buffer before multipart parsing: malformed/truncated uploads never yield a
 * partial form. Optional cancellation interrupts even a blocked reader.read().
 *
 * Fails closed: a body past `maxBytes` is a FormBodyLimitError, checked against
 * the declared Content-Length and again against the actual bytes.
 */
export async function readBoundedFormData(request: Request, maxBytes: number, signal?: AbortSignal): Promise<FormData> {
	signal?.throwIfAborted();
	if (Number(request.headers.get("content-length")) > maxBytes) {
		void request.body?.cancel().catch(() => undefined);
		throw new FormBodyLimitError();
	}
	const body = request.body;
	if (!body) throw new SyntaxError("Missing import body");
	return parse(await readBytes(body, maxBytes, signal), request, signal);
}

/**
 * The same, for a form arriving THROUGH the Proxy.
 *
 * Next buffers the body for the Proxy (experimental.proxyClientMaxBodySize)
 * and drops the epilogue of any part that declares no Content-Length of its
 * own — which is every browser multipart, the shape of both file uploads. The
 * part headers and boundary survive, so the truncated body still PARSES and
 * the round-trip never notices; only a file whose real size matters does
 * (measured: 131072 bytes lost from a 27,328,695-byte body, deterministically).
 *
 * So the Proxy bounds this request instead: the clone stops at
 * proxyClientMaxBodySize, and nothing further can arrive. The body is measured
 * against that allowance and the real bound is enforced on its parts by the
 * caller — the 25 MiB file checks in the import and document routes.
 */
export async function readProxyBoundedFormData(request: Request, maxBytes: number, signal?: AbortSignal): Promise<FormData> {
	signal?.throwIfAborted();
	// A declared length is the client's own claim, but the Proxy still hands on
	// its whole buffer, so an undeclared body is measured against the caller's
	// real bound and a declared one only against the proxy allowance.
	const declared = Number(request.headers.get("content-length"));
	const limit = declared > 0 ? MAX_IMPORT_BODY_BYTES : maxBytes;
	if (declared > limit) {
		void request.body?.cancel().catch(() => undefined);
		throw new FormBodyLimitError();
	}
	const body = request.body;
	if (!body) throw new SyntaxError("Missing import body");
	return parse(await readBytes(body, limit, signal), request, signal);
}

async function parse(bytes: Uint8Array<ArrayBuffer>, request: Request, signal?: AbortSignal): Promise<FormData> {
	const form = await new Response(bytes, { headers: { "Content-Type": request.headers.get("content-type") ?? "" } }).formData();
	signal?.throwIfAborted();
	return form;
}

/** Bounded read off a live stream, so an oversized upload stops the reader. */
async function readBytes(stream: ReadableStream<Uint8Array>, maxBytes: number, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
	const reader = stream.getReader();
	const cancel = () => { void reader.cancel().catch(() => undefined); };
	signal?.addEventListener("abort", cancel, { once: true });
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		signal?.throwIfAborted();
		for (;;) {
			const { done, value } = await reader.read();
			signal?.throwIfAborted();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > maxBytes) throw new FormBodyLimitError();
			chunks.push(value);
		}
	} finally {
		signal?.removeEventListener("abort", cancel);
		// Do not wait for the stream's producer to finish before refusing.
		cancel();
		reader.releaseLock();
	}
	const out = new Uint8Array(bytes);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}