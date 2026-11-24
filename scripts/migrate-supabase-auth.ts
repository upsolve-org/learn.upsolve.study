/**
 * NON-DESTRUCTIVE one-way copy of Supabase auth.users into standalone
 * PostgreSQL. The source connection is READ ONLY: this script issues SELECTs
 * against auth.users and never inserts, updates or deletes there.
 *
 *   SOURCE_DATABASE_URL=postgresql://... DATABASE_URL=postgresql://... \
 *     node --env-file-if-exists=.env node_modules/tsx/dist/cli.mjs \
 *     --import tsx scripts/migrate-supabase-auth.ts
 *
 * Run it with the app stopped. Better Auth migrations are applied to the
 * target first. Re-running is safe: every write is ON CONFLICT DO NOTHING,
 * so an existing target row is never overwritten.
 */
import { Pool } from "pg";
import { runMigrations } from "../src/server/db.ts";

interface SourceUser {
	id: string;
	email: string | null;
	encrypted_password: string | null;
	email_confirmed_at: Date | null;
	created_at: Date;
	updated_at: Date;
}

const sourceUrl = process.env.SOURCE_DATABASE_URL?.trim();
const targetUrl = process.env.DATABASE_URL?.trim();
if (!sourceUrl || !targetUrl) {
	throw new Error("Set SOURCE_DATABASE_URL (read-only Supabase Postgres) and DATABASE_URL (new standalone Postgres).");
}

const source = new Pool({
	connectionString: sourceUrl,
	max: 1,
	connectionTimeoutMillis: 5_000,
	idleTimeoutMillis: 30_000,
});
const target = new Pool({
	connectionString: targetUrl,
	max: 5,
	connectionTimeoutMillis: 5_000,
	idleTimeoutMillis: 30_000,
});

try {
	const applied = await runMigrations(target);
	console.log(`Target migrations applied: ${applied.length ? applied.join(", ") : "none (already current)"}`);

	const { rows: sourceUsers } = await source.query<SourceUser>(`
		SELECT id::text AS id, lower(email) AS email, encrypted_password,
		       email_confirmed_at, created_at, updated_at
		FROM auth.users
		ORDER BY created_at, id
	`);
	console.log(`Source auth.users: ${sourceUsers.length}`);

	const client = await target.connect();
	try {
		await client.query("BEGIN");
		for (const user of sourceUsers) {
			if (!user.id || !user.email) continue;
			await client.query(
				`INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
				 VALUES ($1, $2, $3, $4, $5, $6)
				 ON CONFLICT (id) DO NOTHING`,
				[user.id, user.email, user.email, Boolean(user.email_confirmed_at), user.created_at, user.updated_at],
			);
			await client.query(
				`INSERT INTO "account" (id, "providerId", "accountId", "userId", password, "createdAt", "updatedAt")
				 VALUES ($1, 'credential', $2, $3, $4, $5, $6)
				 ON CONFLICT ("providerId", "accountId") DO NOTHING`,
				[crypto.randomUUID(), user.id, user.id, user.encrypted_password, user.created_at, user.updated_at],
			);
		}
		await client.query("COMMIT");
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
	}

	const ids = sourceUsers.filter((user) => user.id && user.email).map((user) => user.id);
	const [{ rows: targetUsers }, { rows: targetAccounts }] = await Promise.all([
		target.query<{ id: string }>('SELECT id FROM "user" WHERE id = ANY($1::text[])', [ids]),
		target.query<{ accountId: string }>(
			'SELECT "accountId" FROM "account" WHERE "providerId" = $1 AND "accountId" = ANY($2::text[])',
			["credential", ids],
		),
	]);
	const userIds = new Set(targetUsers.map((row) => row.id));
	const accountIds = new Set(targetAccounts.map((row) => row.accountId));
	const missingUsers = ids.filter((id) => !userIds.has(id));
	const missingAccounts = ids.filter((id) => !accountIds.has(id));
	console.log(`Target "user" rows for source ids: ${targetUsers.length}`);
	console.log(`Target "account" rows for source ids: ${targetAccounts.length}`);
	if (missingUsers.length || missingAccounts.length) {
		throw new Error(`Copy incomplete — missing users: ${missingUsers.join(", ") || "none"}; missing accounts: ${missingAccounts.join(", ") || "none"}`);
	}
	console.log(`Verified all ${ids.length} source UUIDs exist in target "user" and "account". Supabase was not modified.`);
} finally {
	await Promise.all([source.end(), target.end()]);
}
