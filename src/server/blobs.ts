/**
 * Owner-scoped uploaded blobs (PR 6). Notes imports may stash a copy of the
 * original file in the blob store with a row in `uploaded_blobs` so it can be
 * served back later. The whole path is a no-op unless S3/RustFS AND the
 * Postgres backend are configured; callers treat archiving as best-effort.
 */

import { randomUUID } from "node:crypto";
import { currentOwnerId } from "../core/owner-scope.ts";
import type { BlobObject } from "../core/ports.ts";
import { extForMime, ownerBlobKey } from "../store/blobs-key.ts";
import { s3BlobConfigured } from "../store/blobs-s3.ts";
import { LOCAL_OWNER } from "../store/postgres/owner.ts";
import { getPgPool, hasDatabaseUrl } from "./db.ts";
import { postgresStorageEnabled, stores } from "./stores.ts";

export interface ArchiveUploadedBlobInput {
	filename: string;
	mimeType: string;
	bytes: Uint8Array;
}

export interface ArchivedUploadedBlob {
	id: string;
	blobKey: string;
}

function uploadDbActive(): boolean {
	return hasDatabaseUrl() && postgresStorageEnabled();
}

/**
 * Store the uploaded bytes under the current owner's namespace and record
 * their metadata. Returns null when S3 is not configured; a failing archive
 * propagates to the caller, which is expected to swallow it.
 */
export async function archiveUploadedBlob(
	input: ArchiveUploadedBlobInput,
): Promise<ArchivedUploadedBlob | null> {
	if (!s3BlobConfigured()) return null;
	const owner = currentOwnerId() ?? LOCAL_OWNER;
	const id = randomUUID();
	// Build the key from the MIME type, never from the client filename: the
	// original name is metadata only and can contain separators or `..`.
	const blobKey = ownerBlobKey(owner, "uploads", `${id}.${extForMime(input.mimeType)}`);
	await stores.blobStore.put(blobKey, input.bytes, input.mimeType);

	if (uploadDbActive()) {
		await getPgPool().query(
			`INSERT INTO uploaded_blobs (owner_id, id, blob_key, filename, mime_type, size_bytes)
			 VALUES ($1, $2, $3, $4, $5, $6)`,
			[owner, id, blobKey, input.filename, input.mimeType, input.bytes.byteLength],
		);
	}
	return { id, blobKey };
}

/** Read an uploaded blob for the CURRENT owner only; null when missing/not owned. */
export async function readUploadedBlob(id: string): Promise<BlobObject | null> {
	if (!s3BlobConfigured() || !uploadDbActive()) return null;
	const owner = currentOwnerId() ?? LOCAL_OWNER;
	const { rows } = await getPgPool().query<{ blob_key: string }>(
		"SELECT blob_key FROM uploaded_blobs WHERE owner_id = $1 AND id = $2",
		[owner, id],
	);
	const blobKey = rows[0]?.blob_key;
	if (!blobKey) return null;
	return stores.blobStore.get(blobKey);
}
