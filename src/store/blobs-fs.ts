/**
 * Local filesystem BlobStore (PR 6). Blobs live under `<data>/blobs` by
 * default, one file per key plus a sibling `.meta.json` carrying the content
 * type. All writes are atomic (temp file + rename) and every key is checked
 * twice: once as a POSIX key, once as a resolved path inside the root.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { baseDataRoot } from "../../config.ts";
import type { BlobHead, BlobObject, BlobStore } from "../core/ports.ts";
import { validateBlobKey } from "./blobs-key.ts";

const DEFAULT_CONTENT_TYPE = "application/octet-stream";

function isNotFound(error: unknown): boolean {
	return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

/** Read a metadata sidecar; a missing sidecar is an old/partial write, not a missing blob. */
async function readContentType(metaPath: string): Promise<string> {
	try {
		const parsed = JSON.parse(await readFile(metaPath, "utf8")) as { contentType?: unknown };
		return typeof parsed.contentType === "string" && parsed.contentType
			? parsed.contentType
			: DEFAULT_CONTENT_TYPE;
	} catch (error) {
		if (isNotFound(error)) return DEFAULT_CONTENT_TYPE;
		throw error;
	}
}

/**
 * The fs adapter. `rootDir` defaults to `<data-root>/blobs`; the scope owner
 * is already the first key segment, so one adapter serves every tenant.
 */
export function createFsBlobStore(rootDir?: string): BlobStore {
	const root = path.resolve(rootDir ?? path.join(baseDataRoot(), "blobs"));

	/** Validate + jail-check a key and return its two absolute paths. */
	function locate(key: string): { file: string; meta: string } {
		const segments = validateBlobKey(key).split("/");
		const file = path.resolve(root, ...segments);
		if (!file.startsWith(root + path.sep)) throw new Error("Blob key escapes the store root");
		return { file, meta: `${file}.meta.json` };
	}

	return {
		async put(key, body, contentType) {
			const { file, meta } = locate(key);
			await mkdir(path.dirname(file), { recursive: true });
			const tmpData = `${file}.tmp-${randomUUID()}`;
			const tmpMeta = `${meta}.tmp-${randomUUID()}`;
			try {
				await writeFile(tmpData, body);
				await writeFile(tmpMeta, JSON.stringify({ contentType }), "utf8");
				await rename(tmpData, file);
				await rename(tmpMeta, meta);
			} catch (error) {
				await Promise.allSettled([unlink(tmpData), unlink(tmpMeta)]);
				throw error;
			}
		},

		async get(key): Promise<BlobObject | null> {
			const { file, meta } = locate(key);
			let bytes: Buffer;
			try {
				bytes = await readFile(file);
			} catch (error) {
				if (isNotFound(error)) return null;
				throw error;
			}
			return {
				body: new Uint8Array(bytes),
				contentType: await readContentType(meta),
				contentLength: bytes.byteLength,
			};
		},

		async head(key): Promise<BlobHead | null> {
			const { file, meta } = locate(key);
			let info: Awaited<ReturnType<typeof stat>>;
			try {
				info = await stat(file);
			} catch (error) {
				if (isNotFound(error)) return null;
				throw error;
			}
			return { contentType: await readContentType(meta), contentLength: info.size };
		},

		async delete(key): Promise<void> {
			const { file, meta } = locate(key);
			for (const target of [file, meta]) {
				try { await unlink(target); }
				catch (error) { if (!isNotFound(error)) throw error; }
			}
		},
	};
}

/** The process-wide fs blob store, swapped out via configureStores() in tests/PR 6 wiring. */
export const fsBlobStore = createFsBlobStore();
