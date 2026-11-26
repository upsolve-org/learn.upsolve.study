/**
 * Operator-only usage statistics reader over PostgreSQL.
 *
 * Callers MUST verify `isOperator(await currentAccountEmail())` before calling
 * `getAdminStats`. Reads only lightweight metadata and usage subfields from
 * `chats` and `jobs` — never full message transcripts or image snapshots.
 */
import type { Pool } from "pg";
import {
	buildAdminStats,
	emptyTokenBreakdown,
	type AdminStatsChatRow,
	type AdminStatsJobRow,
	type AdminStatsRange,
	type AdminStatsSnapshot,
} from "../core/admin-stats.ts";
import type { ExtractionRunUsage, JobUsage, TurnUsage } from "../core/contracts.ts";
import { admittedEmails } from "../core/hosted-admission.ts";
import { getPgPool, hasDatabaseUrl } from "./db.ts";

interface UserDbRow {
	id: string;
	email: string;
}

interface ChatDbRow {
	owner_id: string;
	created_at: Date | string;
	updated_at: Date | string;
	turns: TurnUsage[] | string | null;
	extractions: ExtractionRunUsage[] | string | null;
}

interface JobDbRow {
	owner_id: string;
	updated_at: Date | string;
	usage: JobUsage | string | null;
}

function iso(value: Date | string): string {
	return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function parseJsonField<T>(value: T | string | null | undefined): T | null {
	if (value === null || value === undefined) return null;
	if (typeof value === "string") {
		try {
			return JSON.parse(value) as T;
		} catch {
			return null;
		}
	}
	return value;
}

export async function getAdminStats(range: AdminStatsRange = "all", pool?: Pool): Promise<AdminStatsSnapshot> {
	if (!pool && !hasDatabaseUrl()) {
		return {
			available: false,
			range,
			generatedAt: new Date().toISOString(),
			totals: {
				users: 0,
				activeUsers: 0,
				sessions: 0,
				tokens: emptyTokenBreakdown(),
			},
			users: [],
		};
	}

	const db = pool ?? getPgPool();
	const [usersRes, chatsRes, jobsRes] = await Promise.all([
		db.query<UserDbRow>('SELECT id, email FROM "user"'),
		db.query<ChatDbRow>(
			"SELECT owner_id, created_at, updated_at, record->'turns' AS turns, record->'extractions' AS extractions FROM chats",
		),
		db.query<JobDbRow>("SELECT owner_id, updated_at, payload->'usage' AS usage FROM jobs WHERE payload ? 'usage'"),
	]);

	const chats: AdminStatsChatRow[] = chatsRes.rows.map((row) => ({
		ownerId: row.owner_id,
		createdAt: iso(row.created_at),
		updatedAt: iso(row.updated_at),
		turns: parseJsonField<TurnUsage[]>(row.turns),
		extractions: parseJsonField<ExtractionRunUsage[]>(row.extractions),
	}));

	const jobs: AdminStatsJobRow[] = jobsRes.rows.map((row) => ({
		ownerId: row.owner_id,
		updatedAt: iso(row.updated_at),
		usage: parseJsonField<JobUsage>(row.usage),
	}));

	return buildAdminStats(
		{
			users: usersRes.rows,
			admittedEmails: admittedEmails(),
			chats,
			jobs,
		},
		range,
	);
}
