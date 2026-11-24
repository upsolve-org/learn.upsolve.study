-- Blob references (PR 6). Chat image snapshots may now point at an object
-- in the blob store instead of carrying base64 bytes in `data`. Every
-- statement is idempotent so a partially-applied install is safe to re-run.
-- Inline rows keep working: data stays non-null until a migration verifies
-- the copy in the object store (scripts/migrate-blobs-to-rustfs.ts).

ALTER TABLE chat_image_snapshots ADD COLUMN IF NOT EXISTS blob_key TEXT;

ALTER TABLE chat_image_snapshots ALTER COLUMN data DROP NOT NULL;

CREATE INDEX IF NOT EXISTS chat_image_snapshots_blob_key_idx
    ON chat_image_snapshots (owner_id, blob_key) WHERE blob_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS uploaded_blobs (
    owner_id TEXT NOT NULL,
    id TEXT NOT NULL,
    blob_key TEXT NOT NULL,
    filename TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (owner_id, id)
);

CREATE INDEX IF NOT EXISTS uploaded_blobs_owner_created_idx
    ON uploaded_blobs (owner_id, created_at DESC);
