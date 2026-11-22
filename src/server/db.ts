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

/**
 * Apply every not-yet-applied *.sql file from db/migrations/ in version order.
 * Each file runs in one transaction together with its version marker, so a
 * failed migration is never recorded as applied. Returns the versions applied
 * by this call (empty when the database is already current).
 */
export async function runMigrations(pool: Pool = getPgPool(), migrationsDir?: string): Promise<string[]> {
	const dir = migrationsDir ?? path.join(process.cwd(), "db", "migrations");
	// The tracking table must exist before we can decide what to run; the
	// migration itself also creates it (idempotently) for a fresh database.
	await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
		version TEXT PRIMARY KEY,
		applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
	)`);
	const { rows } = await pool.query<{ version: string }>("SELECT version FROM schema_migrations");
	const applied = new Set(rows.map((row) => row.version));
	const files = (await readdir(dir)).filter((name) => name.endsWith(".sql")).sort();
	const ran: string[] = [];
	for (const version of files) {
		if (applied.has(version)) continue;
		const sql = await readFile(path.join(dir, version), "utf8");
		const client = await pool.connect();
		try {
			await client.query("BEGIN");
			await client.query(sql);
			await client.query("INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT DO NOTHING", [version]);
			await client.query("COMMIT");
			ran.push(version);
		} catch (error) {
			await client.query("ROLLBACK");
			throw error;
		} finally {
			client.release();
		}
	}
	return ran;
}
