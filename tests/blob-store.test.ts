/**
 * PR 6 pins: the blob-references migration, key validation, both adapters,
 * the Postgres snapshot offload/hydration seam, and the raw snapshot route.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import {
	DeleteObjectCommand,
	GetObjectCommand,
	HeadObjectCommand,
	PutObjectCommand,
	type S3Client,
} from "@aws-sdk/client-s3";
import type { Pool } from "pg";
import { GET } from "../app/api/chats/[id]/images/[snapshotId]/route.ts";
import { chatStore } from "../src/store/chats.ts";
import { extForMime, ownerBlobKey, validateBlobKey } from "../src/store/blobs-key.ts";
import { createFsBlobStore } from "../src/store/blobs-fs.ts";
import { createS3BlobStore, s3BlobConfigured } from "../src/store/blobs-s3.ts";
import { createPostgresChatStore } from "../src/store/postgres/chats.ts";
import type { BlobStore } from "../src/core/ports.ts";

// ─── migration ────────────────────────────────────────────────────────────────

describe("003_blob_references.sql", () => {
	const sql = readFileSync(path.join(process.cwd(), "db", "migrations", "003_blob_references.sql"), "utf8");

	it("adds blob references and the uploaded_blobs table idempotently", () => {
		assert.match(sql, /ALTER TABLE chat_image_snapshots ADD COLUMN IF NOT EXISTS blob_key TEXT;/);
		assert.match(sql, /ALTER TABLE chat_image_snapshots ALTER COLUMN data DROP NOT NULL;/);
		assert.match(sql, /CREATE INDEX IF NOT EXISTS chat_image_snapshots_blob_key_idx/);
		assert.match(sql, /CREATE TABLE IF NOT EXISTS uploaded_blobs \(/);
		assert.match(sql, /CREATE INDEX IF NOT EXISTS uploaded_blobs_owner_created_idx/);
		assert.match(sql, /PRIMARY KEY \(owner_id, id\)/);
		for (const column of ["owner_id", "blob_key", "filename", "mime_type", "size_bytes", "created_at"]) {
			assert.match(sql, new RegExp(`\\b${column}\\b`), `missing column ${column}`);
		}
	});

	it("repeats the IF NOT EXISTS / IF EXISTS idioms so it is re-runnable", () => {
		assert.ok(!/CREATE TABLE uploaded_blobs/i.test(sql.replace("CREATE TABLE IF NOT EXISTS uploaded_blobs", "")));
		assert.ok(sql.includes("IF NOT EXISTS"));
	});
});

// ─── keys ─────────────────────────────────────────────────────────────────────

describe("blob keys", () => {
	it("normalizes repeated slashes and keeps clean POSIX keys", () => {
		assert.equal(validateBlobKey("owner/images/a.png"), "owner/images/a.png");
		assert.equal(validateBlobKey("owner//images///a.png"), "owner/images/a.png");
		assert.equal(validateBlobKey("a.bin"), "a.bin");
	});

	it("rejects empty keys, leading/trailing slashes, backslashes, null bytes and dot segments", () => {
		for (const key of [
			"", "/owner/images/a.png", "owner/images/a.png/", "owner\\images\\a.png",
			"owner/images/a\0.png", "owner/../secret", "owner/./images/a.png", "owner/images/..",
			"owner/images/../secret", "owner/images/./a.png", "owner//../secret",
		]) {
			assert.throws(() => validateBlobKey(key), /Blob key/, `expected rejection: ${JSON.stringify(key)}`);
		}
	});

	it("builds owner-scoped keys and validates the result", () => {
		assert.equal(ownerBlobKey("owner-1", "images", "abc.png"), "owner-1/images/abc.png");
		assert.equal(ownerBlobKey("owner-1", "uploads", "f.bin"), "owner-1/uploads/f.bin");
		assert.throws(() => ownerBlobKey("owner-1", "images", "../secret"));
	});

	it("maps MIME types to extensions, including parameters and unknown types", () => {
		assert.equal(extForMime("image/png"), "png");
		assert.equal(extForMime("image/jpeg"), "jpg");
		assert.equal(extForMime("image/webp"), "webp");
		assert.equal(extForMime("image/gif"), "gif");
		assert.equal(extForMime("image/bmp"), "bmp");
		assert.equal(extForMime("application/pdf"), "pdf");
		assert.equal(extForMime("text/markdown"), "md");
		assert.equal(extForMime("text/plain"), "txt");
		assert.equal(extForMime("text/plain; charset=utf-8"), "txt");
		assert.equal(extForMime("image/avif"), "bin");
	});
});

// ─── fs adapter ───────────────────────────────────────────────────────────────

describe("createFsBlobStore", () => {
	it("full CRUD lifecycle, missing blobs and idempotent delete", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "lh-blobs-fs-"));
		try {
			const store = createFsBlobStore(root);
			const bytes = new Uint8Array([0, 1, 2, 250, 255]);
			const key = "owner/images/pic.png";
			assert.equal(await store.head(key), null);
			assert.equal(await store.get(key), null);

			await store.put(key, bytes, "image/png");
			const got = await store.get(key);
			assert.deepEqual(got?.body, bytes);
			assert.equal(got?.contentType, "image/png");
			assert.equal(got?.contentLength, bytes.byteLength);
			assert.deepEqual(await store.head(key), { contentType: "image/png", contentLength: bytes.byteLength });

			await store.delete(key);
			await store.delete(key); // idempotent on ENOENT
			assert.equal(await store.get(key), null);
			assert.equal(await store.head(key), null);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("overwrites atomically and refuses escaping keys", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "lh-blobs-fs-"));
		try {
			const store = createFsBlobStore(root);
			await store.put("a/b.txt", new Uint8Array([1]), "text/plain");
			await store.put("a/b.txt", new Uint8Array([2, 3]), "text/plain");
			assert.deepEqual((await store.get("a/b.txt"))?.body, new Uint8Array([2, 3]));
			await assert.rejects(async () => { await store.put("../escape", new Uint8Array([1]), "text/plain"); });
			await assert.rejects(async () => { await store.get("/absolute"); });
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});

// ─── S3 adapter ───────────────────────────────────────────────────────────────

const S3_CONFIG = {
	endpoint: "http://localhost:9000",
	bucket: "learn",
	accessKeyId: "key",
	secretAccessKey: "secret",
	region: "us-east-1",
};

function s3Mock(responder: (command: object) => Promise<unknown> | unknown) {
	const calls: object[] = [];
	const client = {
		async send(command: object) {
			calls.push(command);
			return responder(command);
		},
	} as unknown as Pick<S3Client, "send">;
	return { client, calls };
}

describe("createS3BlobStore", () => {
	it("s3BlobConfigured requires all four trimmed variables; region defaults", async () => {
		const env = {
			S3_ENDPOINT: "http://localhost:9000", S3_BUCKET: "b",
			S3_ACCESS_KEY_ID: "id", S3_SECRET_ACCESS_KEY: "sk",
		};
		assert.equal(s3BlobConfigured(env), true);
		assert.equal(s3BlobConfigured({ ...env, S3_BUCKET: "  " }), false);
		assert.equal(s3BlobConfigured({ ...env, S3_ENDPOINT: undefined }), false);
		const { readS3BlobConfig } = await import("../src/store/blobs-s3.ts");
		assert.equal(readS3BlobConfig(env).region, "us-east-1");
		assert.equal(readS3BlobConfig({ ...env, S3_REGION: " eu-west-1 " }).region, "eu-west-1");
		assert.throws(() => readS3BlobConfig({ ...env, S3_SECRET_ACCESS_KEY: "" }), /Missing S3 configuration/);
	});

	it("issues the four expected commands and reads standard SDK bodies", async () => {
		const body = new Uint8Array([9, 8, 7]);
		const { client, calls } = s3Mock((command) => {
			if (command instanceof GetObjectCommand) {
				return { Body: { transformToByteArray: async () => body }, ContentType: "image/png", ContentLength: 3 };
			}
			if (command instanceof HeadObjectCommand) return { ContentType: "image/png", ContentLength: 3 };
			return {};
		});
		const store = createS3BlobStore(S3_CONFIG, client);
		await store.put("owner/images/a.png", body, "image/png");
		const got = await store.get("owner/images/a.png");
		assert.deepEqual(got?.body, body);
		assert.equal(got?.contentType, "image/png");
		assert.equal(got?.contentLength, 3);
		assert.deepEqual(await store.head("owner/images/a.png"), { contentType: "image/png", contentLength: 3 });
		await store.delete("owner/images/a.png");

		assert.ok(calls[0] instanceof PutObjectCommand);
		assert.equal((calls[0] as PutObjectCommand).input.Key, "owner/images/a.png");
		assert.equal((calls[0] as PutObjectCommand).input.ContentType, "image/png");
		assert.ok(calls[1] instanceof GetObjectCommand);
		assert.ok(calls[2] instanceof HeadObjectCommand);
		assert.ok(calls[3] instanceof DeleteObjectCommand);
	});

	it("maps 404 / NoSuchKey / NotFound to null or no-op, and validates keys", async () => {
		for (const error of [
			Object.assign(new Error("no key"), { name: "NoSuchKey" }),
			Object.assign(new Error("gone"), { name: "NotFound", $metadata: { httpStatusCode: 404 } }),
			Object.assign(new Error("gone"), { Code: "NoSuchKey" }),
		]) {
			const { client } = s3Mock(() => { throw error; });
			const store = createS3BlobStore(S3_CONFIG, client);
			assert.equal(await store.get("owner/images/missing.png"), null);
			assert.equal(await store.head("owner/images/missing.png"), null);
			await store.delete("owner/images/missing.png"); // idempotent
		}
		const { client, calls } = s3Mock(() => ({}));
		const store = createS3BlobStore(S3_CONFIG, client);
		await assert.rejects(async () => { await store.put("../escape", new Uint8Array([1]), "text/plain"); });
		assert.equal(calls.length, 0);
	});

	it("reads Buffer / Uint8Array / async-iterable mock bodies", async () => {
		for (const Body of [Buffer.from([1, 2]), new Uint8Array([1, 2]), (async function* () { yield new Uint8Array([1]); yield new Uint8Array([2]); })()]) {
			const { client } = s3Mock(() => ({ Body }));
			const got = await createS3BlobStore(S3_CONFIG, client).get("owner/a.bin");
			assert.deepEqual(got?.body, new Uint8Array([1, 2]));
		}
	});
});

// ─── postgres offload ─────────────────────────────────────────────────────────

interface Call { sql: string; params: unknown[] }
interface Reply { rows: unknown[]; rowCount?: number }

function makePool(responder: (call: Call) => Reply) {
	const calls: Call[] = [];
	const clients: Call[][] = [];
	const run = (call: Call) => { calls.push(call); return responder(call); };
	const pool = {
		calls,
		clients,
		async query(sql: string, params: unknown[] = []) { return run({ sql, params }); },
		async connect() {
			const history: Call[] = [];
			clients.push(history);
			return {
				query(sql: string, params: unknown[] = []) {
					const call = { sql, params };
					history.push(call);
					return Promise.resolve(responder(call));
				},
				release() {},
			};
		},
	};
	return pool as unknown as Pool & { calls: Call[]; clients: Call[][] };
}

const ISO = "2026-01-01T00:00:00.000Z";
const chatRow = () => ({
	id: "chat_1", title: "Title", kind: "teach", created_at: ISO, updated_at: ISO,
	version: 2, message_count: 0, phase: "probe", pending_question: false, pending_problem: false,
	record: { id: "chat_1", title: "Title", createdAt: ISO, updatedAt: ISO, messages: [], version: 2 },
});

function memoryBlobStore() {
	const blobs = new Map<string, { body: Uint8Array; contentType: string }>();
	let gets = 0;
	const store: BlobStore = {
		async put(key, body, contentType) { blobs.set(key, { body: new Uint8Array(body), contentType }); },
		async get(key) {
			gets++;
			const found = blobs.get(key);
			return found ? { ...found, contentLength: found.body.byteLength } : null;
		},
		async head(key) {
			const found = blobs.get(key);
			return found ? { contentType: found.contentType, contentLength: found.body.byteLength } : null;
		},
		async delete(key) { blobs.delete(key); },
	};
	return { store, blobs, getCount: () => gets };
}

describe("PostgresChatStore snapshot offload", () => {
	const bytes = Buffer.from("picture");
	const data = bytes.toString("base64");
	const snapshotId = createHash("sha256").update(bytes).digest("hex");
	const image = { mimeType: "image/png" as const, data, width: 1, height: 1 };

	function setup() {
		let snapshotRows: Array<Record<string, unknown>> = [];
		const pool = makePool(({ sql }) => {
			if (sql.includes("FROM chat_image_snapshots")) return { rows: snapshotRows };
			if (sql.includes("FROM chats WHERE")) return { rows: [chatRow()] };
			return { rows: [] };
		});
		return { pool, setRows: (rows: Array<Record<string, unknown>>) => { snapshotRows = rows; } };
	}

	it("offloads saveImageSnapshot to the blob store and records a NULL data column", async () => {
		const { pool, setRows } = setup();
		const { store, blobs } = memoryBlobStore();
		const adapter = createPostgresChatStore(pool, { blobStore: store, offloadSnapshots: true });
		await adapter.saveImageSnapshot("chat_1", snapshotId, image);
		const key = `__local__/images/${snapshotId}.png`;
		assert.deepEqual([...blobs.keys()], [key]);
		assert.deepEqual(blobs.get(key)?.body, new Uint8Array(bytes));
		const insert = pool.clients[0]!.find((call) => call.sql.includes("INSERT INTO chat_image_snapshots"))!;
		assert.match(insert.sql, /\(owner_id, chat_id, snapshot_id, mime_type, data, blob_key, width, height\)/);
		assert.match(insert.sql, /VALUES \(\$1, \$2, \$3, \$4, NULL, \$5, \$6, \$7\)/);
		assert.equal(insert.params[4], key);

		setRows([{ snapshot_id: snapshotId, mime_type: "image/png", data: null, blob_key: key, width: 1, height: 1 }]);
		const chat = await adapter.getChat("chat_1");
		assert.equal(chat?.imageSnapshots?.[snapshotId]?.data, data);
		assert.equal(chat?.imageSnapshots?.[snapshotId]?.width, 1);
	});

	it("still reads legacy inline rows and keeps inline writes when offload is off", async () => {
		const { pool, setRows } = setup();
		const { store, blobs, getCount } = memoryBlobStore();
		setRows([{ snapshot_id: snapshotId, mime_type: "image/png", data, blob_key: null, width: 1, height: 1 }]);
		const offloaded = createPostgresChatStore(pool, { blobStore: store, offloadSnapshots: true });
		assert.equal((await offloaded.getChat("chat_1"))?.imageSnapshots?.[snapshotId]?.data, data);
		assert.equal(getCount(), 0, "legacy inline data needs no blob fetch");

		const inline = createPostgresChatStore(pool);
		await inline.saveImageSnapshot("chat_1", snapshotId, image);
		assert.equal(blobs.size, 0);
		const insert = pool.clients.at(-1)!.find((call) => call.sql.includes("INSERT INTO chat_image_snapshots"))!;
		assert.equal(insert.params[4], data);
		assert.match(insert.sql, /\(owner_id, chat_id, snapshot_id, mime_type, data, width, height\)/);
	});

	it("getChat selects blob_key alongside the legacy data column", async () => {
		const { pool } = setup();
		await createPostgresChatStore(pool).getChat("chat_1");
		const select = pool.calls.find((call) => call.sql.includes("FROM chat_image_snapshots"))!;
		assert.match(select.sql, /SELECT snapshot_id, mime_type, data, blob_key, width, height/);
	});
});

// ─── route ────────────────────────────────────────────────────────────────────

const chats: string[] = [];
after(async () => {
	for (const id of chats) await chatStore.deleteChat(id);
});

describe("GET /api/chats/[id]/images/[snapshotId]", () => {
	it("serves raw bytes and keeps the default JSON response", async () => {
		const chat = await chatStore.createChat("Blob-store route pin " + randomUUID());
		chats.push(chat.id);
		const bytes = Buffer.from("raw-picture-bytes");
		const id = createHash("sha256").update(bytes).digest("hex");
		const image = { mimeType: "image/png" as const, data: bytes.toString("base64"), width: 1, height: 1 };
		await chatStore.saveImageSnapshot(chat.id, id, image);
		const params = () => Promise.resolve({ id: chat.id, snapshotId: id });

		const json = await GET(new Request("http://localhost/api/chats/x/images/y"), { params: params() });
		assert.equal(json.status, 200);
		assert.equal(json.headers.get("cache-control"), "private, no-store");
		assert.deepEqual(await json.json(), image);

		const raw = await GET(new Request("http://localhost/api/chats/x/images/y?format=raw"), { params: params() });
		assert.equal(raw.status, 200);
		assert.equal(raw.headers.get("content-type"), "image/png");
		assert.equal(raw.headers.get("x-content-type-options"), "nosniff");
		assert.equal(raw.headers.get("cache-control"), "private, max-age=31536000, immutable");
		assert.deepEqual(new Uint8Array(await raw.arrayBuffer()), new Uint8Array(bytes));
	});

	it("404s on invalid or missing snapshots", async () => {
		const chat = await chatStore.createChat("Blob-store 404 pin " + randomUUID());
		chats.push(chat.id);
		const missing = createHash("sha256").update(Buffer.from("missing")).digest("hex");
		for (const snapshotId of ["../file", missing]) {
			const response = await GET(new Request("http://localhost/api/chats/x/images/y?format=raw"), {
				params: Promise.resolve({ id: chat.id, snapshotId }),
			});
			assert.equal(response.status, 404);
		}
	});
});
