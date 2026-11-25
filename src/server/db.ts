/**
 * Standalone PostgreSQL access (PR 4). The pool is the single connection
 * boundary for Better Auth, provisioning and the read-only Supabase migration
 * source reader; nothing in src/core may import this module (import law).
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";

declare global {
	// Cached across module reloads (dev/HMR) so one process owns one pool.
	var __lhPgPool: Pool | undefined;
	var __lhPgPoolUrl: string | undefined;
}

type Env = Record<string, string | undefined>;

const POOL_SETTINGS = {
	max: 15,
	idleTimeoutMillis: 30_000,
	connectionTimeoutMillis: 5_000,
} as const;

/** Boot/config check without opening a connection. */
export function hasDatabaseUrl(env: Env = process.env): boolean {
	return Boolean(env.DATABASE_URL?.trim());
}

/**
 * The shared pool for the default DATABASE_URL. An explicit connection string
 * (the migration script's target, or a test) gets its own untracked pool.
 */
export function getPgPool(connectionString?: string): Pool {
	const url = (connectionString ?? process.env.DATABASE_URL ?? "").trim();
	if (!url) throw new Error("DATABASE_URL is not configured.");
	if (connectionString) return new Pool({ connectionString: url, ...POOL_SETTINGS });
	if (globalThis.__lhPgPool && globalThis.__lhPgPoolUrl === url) return globalThis.__lhPgPool;
	globalThis.__lhPgPool = new Pool({ connectionString: url, ...POOL_SETTINGS });
	globalThis.__lhPgPoolUrl = url;
	return globalThis.__lhPgPool;
}

/** Release the shared pool (build teardown / tests). */
export async function closePgPool(): Promise<void> {
	const pool = globalThis.__lhPgPool;
	if (!pool) return;
	globalThis.__lhPgPool = undefined;
	globalThis.__lhPgPoolUrl = undefined;
	await pool.end();
}

/** Arbitrary, stable key for the migration advisory lock ("lhmigr" in hex). */
const MIGRATION_LOCK_KEY = 0x6c686d696772;

/**
 * Apply every not-yet-applied *.sql file from db/migrations/ in version order.
 * Each file runs in one transaction together with its version marker, so a
 * failed migration is never recorded as applied. Returns the versions applied
 * by this call (empty when the database is already current).
 *
 * The web app and the job worker both migrate at boot; a session-level
 * advisory lock serialises them so two processes never race the same
 * CREATE TABLE IF NOT EXISTS (which can still collide on pg_type).
 */
export async function runMigrations(pool: Pool = getPgPool(), migrationsDir?: string): Promise<string[]> {
	const dir = migrationsDir ?? path.join(/* turbopackIgnore: true */ process.cwd(), "db", "migrations");
	const files = (await readdir(dir)).filter((name) => name.endsWith(".sql")).sort();
	const client = await pool.connect();
	try {
		await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
		try {
			// The tracking table must exist before we can decide what to run; the
			// migration itself also creates it (idempotently) for a fresh database.
			await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
				version TEXT PRIMARY KEY,
				applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
			)`);
			const { rows } = await client.query<{ version: string }>("SELECT version FROM schema_migrations");
			const applied = new Set(rows.map((row) => row.version));
			const ran: string[] = [];
			for (const version of files) {
				if (applied.has(version)) continue;
				const sql = await readFile(path.join(/* turbopackIgnore: true */ dir, version), "utf8");
				try {
					await client.query("BEGIN");
					await client.query(sql);
					await client.query("INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT DO NOTHING", [version]);
					await client.query("COMMIT");
					ran.push(version);
				} catch (error) {
					await client.query("ROLLBACK");
					throw error;
				}
			}
			return ran;
		} finally {
			await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
		}
	} finally {
		client.release();
	}
}
