/**
 * Non-destructive copy of inline chat image snapshots into RustFS/S3 (PR 6).
 *
 *   DATABASE_URL=... S3_ENDPOINT=... S3_BUCKET=... \
 *   S3_ACCESS_KEY_ID=... S3_SECRET_ACCESS_KEY=... \
 *     node --env-file-if-exists=.env node_modules/tsx/dist/cli.mjs \
 *       --import tsx scripts/migrate-blobs-to-rustfs.ts [--clear-inline-after-verify]
 *
 * Every row is uploaded and verified against HEAD before its `blob_key` is
 * recorded. Inline `data` is cleared ONLY with the explicit flag — the
 * default run is strictly additive and safe to repeat.
 */

import { extForMime, ownerBlobKey } from "../src/store/blobs-key.ts";
import { createS3BlobStore, s3BlobConfigured } from "../src/store/blobs-s3.ts";
import { getPgPool, hasDatabaseUrl, runMigrations } from "../src/server/db.ts";

interface InlineSnapshot {
	owner_id: string;
	chat_id: string;
	snapshot_id: string;
	mime_type: string;
	data: string;
}

const clearInline = process.argv.includes("--clear-inline-after-verify");

async function main(): Promise<void> {
	if (!hasDatabaseUrl()) throw new Error("DATABASE_URL is required to migrate blobs.");
	if (!s3BlobConfigured()) {
		throw new Error("S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are all required.");
	}

	const pool = getPgPool();
	try {
		await runMigrations(pool);
		const blobStore = createS3BlobStore();
		const { rows } = await pool.query<InlineSnapshot>(
			`SELECT owner_id, chat_id, snapshot_id, mime_type, data
			   FROM chat_image_snapshots WHERE blob_key IS NULL AND data IS NOT NULL
			  ORDER BY owner_id, chat_id, snapshot_id`,
		);
		const counts = { scanned: rows.length, uploaded: 0, verified: 0, failed: 0 };
		for (const row of rows) {
			const key = ownerBlobKey(row.owner_id, "images", `${row.snapshot_id}.${extForMime(row.mime_type)}`);
			const bytes = new Uint8Array(Buffer.from(row.data, "base64"));
			try {
				await blobStore.put(key, bytes, row.mime_type);
				counts.uploaded++;
				const head = await blobStore.head(key);
				if (!head || head.contentLength !== bytes.byteLength) {
					throw new Error(`Verification failed for ${key} (expected ${bytes.byteLength} bytes)`);
				}
				counts.verified++;
				await pool.query(
					clearInline
						? `UPDATE chat_image_snapshots SET blob_key = $1, data = NULL
						    WHERE owner_id = $2 AND chat_id = $3 AND snapshot_id = $4`
						: "UPDATE chat_image_snapshots SET blob_key = $1 WHERE owner_id = $2 AND chat_id = $3 AND snapshot_id = $4",
					[key, row.owner_id, row.chat_id, row.snapshot_id],
				);
			} catch (error) {
				counts.failed++;
				console.error(`[blobs] ${row.owner_id}/${row.chat_id}/${row.snapshot_id}:`, error);
			}
		}
		console.info(`[blobs] scanned=${counts.scanned} uploaded=${counts.uploaded} verified=${counts.verified} failed=${counts.failed}${clearInline ? " (inline data cleared)" : " (inline data kept)"}`);
		if (counts.failed > 0) process.exitCode = 1;
	} finally {
		await pool.end();
	}
}

main().catch((error) => {
	console.error("[blobs] fatal:", error);
	process.exitCode = 1;
});
