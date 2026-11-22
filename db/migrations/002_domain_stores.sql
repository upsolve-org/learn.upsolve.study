-- Domain storage for the PostgreSQL backend (PR 5). Every statement is
-- idempotent: src/server/db.ts runs this file once per version, but a
-- partially-applied install must also be safe to re-run by hand.
--
-- Ownership is a TEXT tenant key, never a client-supplied path. Unscoped
-- desktop/local data is stored under the LOCAL_OWNER sentinel from
-- src/store/postgres/owner.ts, so every row still has an owner_id.
--
-- Chat metadata is duplicated into lightweight columns so the sidebar list
-- never has to read the (potentially large) record JSONB or the image
-- snapshots. The record column remains the authoritative full ChatRecord;
-- processed pictures live in their own table and are merged on read.

CREATE TABLE IF NOT EXISTS chats (
    owner_id TEXT NOT NULL,
    id TEXT NOT NULL,
    title TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'teach',
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    version INT NOT NULL DEFAULT 1,
    message_count INT NOT NULL DEFAULT 0,
    phase TEXT NOT NULL DEFAULT 'probe',
    pending_question BOOLEAN NOT NULL DEFAULT FALSE,
    pending_problem BOOLEAN NOT NULL DEFAULT FALSE,
    record JSONB NOT NULL,
    PRIMARY KEY (owner_id, id)
);

CREATE INDEX IF NOT EXISTS chats_owner_updated_idx ON chats (owner_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS chat_image_snapshots (
    owner_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    snapshot_id TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    data TEXT NOT NULL,
    width INT NOT NULL,
    height INT NOT NULL,
    PRIMARY KEY (owner_id, chat_id, snapshot_id),
    FOREIGN KEY (owner_id, chat_id) REFERENCES chats (owner_id, id) ON DELETE CASCADE
);

-- Append-only ledgers. seq is the append order: reads MUST ORDER BY seq ASC
-- to reproduce the JSONL file's line order exactly.
CREATE TABLE IF NOT EXISTS graph_nodes (
    seq BIGSERIAL PRIMARY KEY,
    owner_id TEXT NOT NULL,
    id TEXT NOT NULL,
    payload JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS graph_nodes_owner_seq_idx ON graph_nodes (owner_id, seq);

CREATE TABLE IF NOT EXISTS graph_chains (
    seq BIGSERIAL PRIMARY KEY,
    owner_id TEXT NOT NULL,
    id TEXT NOT NULL,
    payload JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS graph_chains_owner_seq_idx ON graph_chains (owner_id, seq);

CREATE TABLE IF NOT EXISTS graph_checkpoints (
    seq BIGSERIAL PRIMARY KEY,
    owner_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    payload JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS graph_checkpoints_owner_seq_idx ON graph_checkpoints (owner_id, seq);

CREATE TABLE IF NOT EXISTS graph_coverage (
    seq BIGSERIAL PRIMARY KEY,
    owner_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    payload JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS graph_coverage_owner_seq_idx ON graph_coverage (owner_id, seq);

-- Map-shaped records (one row per owner/source/theme/segment).
CREATE TABLE IF NOT EXISTS graph_sources (
    owner_id TEXT NOT NULL,
    id TEXT NOT NULL,
    payload JSONB NOT NULL,
    PRIMARY KEY (owner_id, id)
);

CREATE TABLE IF NOT EXISTS graph_positions (
    owner_id TEXT NOT NULL PRIMARY KEY,
    positions JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS source_organization (
    owner_id TEXT NOT NULL PRIMARY KEY,
    state JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS jobs (
    owner_id TEXT NOT NULL,
    id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    tool_call_id TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    payload JSONB NOT NULL,
    PRIMARY KEY (owner_id, id)
);

CREATE INDEX IF NOT EXISTS jobs_owner_chat_idx ON jobs (owner_id, chat_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS user_settings (
    owner_id TEXT NOT NULL PRIMARY KEY,
    settings JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_themes (
    owner_id TEXT NOT NULL,
    id TEXT NOT NULL,
    theme JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (owner_id, id)
);

CREATE TABLE IF NOT EXISTS prompt_overrides (
    owner_id TEXT NOT NULL,
    segment_path TEXT NOT NULL,
    content TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (owner_id, segment_path)
);

-- Operator-level tables (email keys, NOT owner-scoped).
CREATE TABLE IF NOT EXISTS admissions (
    email TEXT PRIMARY KEY,
    admitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS signup_requests (
    email TEXT PRIMARY KEY,
    requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS issued_credentials (
    email TEXT PRIMARY KEY,
    payload JSONB NOT NULL,
    issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
