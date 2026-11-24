/**
 * Real RustFS (S3) + PostgreSQL 17 blob offload integration test:
 *   1. S3BlobStore put / head / get / delete round-trip against live RustFS
 *      (including missing-key null/no-op semantics).
 *   2. PostgresChatStore with offloadSnapshots=true stores image bytes in
 *      RustFS (setting blob_key, leaving inline data NULL) and rehydrates
 *      the snapshot transparently on getImageSnapshot().
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { closePgPool, getPgPool, runMigrations } from "../../src/server/db.ts";
import { createS3BlobStore, readS3BlobConfig } from "../../src/store/blobs-s3.ts";
import { createPostgresChatStore } from "../../src/store/postgres/chats.ts";
import { runAsOwner } from "../../src/core/owner-scope.ts";

const config = readS3BlobConfig();
const blobStore = createS3BlobStore(config);
const pool = getPgPool();
const OWNER = randomUUID();
const createdKeys: string[] = [];

before(async () => {
	await runMigrations(pool);
	const client = new S3Client({
		endpoint: config.endpoint,
		region: config.region,
		forcePathStyle: true,
		credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
	});
	try {
		await client.send(new CreateBucketCommand({ Bucket: config.bucket }));
	} catch (error: unknown) {
		const name = (error as { name?: string; Code?: string })?.name ?? (error as { Code?: string })?.Code ?? "";
		if (name !== "BucketAlreadyOwnedByYou" && name !== "BucketAlreadyExists") throw error;
	}
});

after(async () => {
	for (const key of createdKeys) {
		await Promise.resolve(blobStore.delete(key)).catch(() => undefined);
	}
	await pool.query("DELETE FROM chats WHERE owner_id = $1", [OWNER]);
	await closePgPool();
});

describe("RustFS S3 BlobStore", () => {
	it("supports put, head, get, delete, and missing-key null semantics", async () => {
		const key = `ci/${randomUUID()}/sample.txt`;
		createdKeys.push(key);
		const payload = new TextEncoder().encode("hello rustfs integration");

		assert.equal(await blobStore.head(key), null);
		assert.equal(await blobStore.get(key), null);

		await blobStore.put(key, payload, "text/plain");

		const head = await blobStore.head(key);
		assert.ok(head);
		assert.equal(head.contentLength, payload.byteLength);
		assert.match(head.contentType, /^text\/plain/);

		const fetched = await blobStore.get(key);
		assert.ok(fetched);
		assert.deepEqual(Buffer.from(fetched.body), Buffer.from(payload));

		await blobStore.delete(key);
		assert.equal(await blobStore.head(key), null);
		assert.equal(await blobStore.get(key), null);
		// Deleting a missing key is a no-op.
		await blobStore.delete(key);
	});

	it("offloads chat image snapshots from Postgres to RustFS and rehydrates them on read", async () => {
		const chatStore = createPostgresChatStore(pool, { blobStore, offloadSnapshots: true });
		const chat = await runAsOwner(OWNER, () => chatStore.createChat("Image Offload Test"));
		const pngBytes = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

		await runAsOwner(OWNER, () =>
			chatStore.saveImageSnapshot(chat.id, "snap_ci_1", {
				mimeType: "image/png",
				data: pngBytes.toString("base64"),
				width: 1,
				height: 1,
			}),
		);

		// Confirm Postgres stored blob_key and left inline data NULL.
		const { rows } = await pool.query<{ data: string | null; blob_key: string | null }>(
			"SELECT data, blob_key FROM chat_image_snapshots WHERE owner_id = $1 AND chat_id = $2 AND snapshot_id = $3",
			[OWNER, chat.id, "snap_ci_1"],
		);
		assert.equal(rows.length, 1);
		assert.equal(rows[0]!.data, null, "offloaded snapshot should not duplicate base64 inline in Postgres");
		assert.ok(rows[0]!.blob_key, "offloaded snapshot must record blob_key");
		createdKeys.push(rows[0]!.blob_key);

		// Reading through chatStore transparently fetches bytes from RustFS.
		const reloaded = await runAsOwner(OWNER, () => chatStore.getChat(chat.id));
		const rehydrated = reloaded?.imageSnapshots?.["snap_ci_1"];
		assert.ok(rehydrated);
		assert.equal(rehydrated.data, pngBytes.toString("base64"));
		assert.equal(rehydrated.mimeType, "image/png");
	});
});
