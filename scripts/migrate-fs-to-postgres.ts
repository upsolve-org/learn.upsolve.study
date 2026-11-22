/**
 * NON-DESTRUCTIVE one-way copy of the FS data tree into PostgreSQL (PR 5).
 *
 *   DATABASE_URL=postgresql://... node --env-file-if-exists=.env \
 *     node_modules/tsx/dist/cli.mjs --import tsx scripts/migrate-fs-to-postgres.ts \
 *     [--include-legacy]
 *
 * The source tree (LH_DATA_DIR, default ./data) is READ ONLY: this script
 * only ever calls readFile/readdir against it. It never writes, renames or
 * deletes a local file. Migrations are applied to the target first. Every
 * write is idempotent (ON CONFLICT DO NOTHING; append-only ledgers are
 * skipped when rows already exist for that owner), so a re-run is safe.
 *
 * `--include-legacy` also copies the unscoped legacy root (data/chats,
 * data/graph, …) under the LOCAL_OWNER key. Hosted owner roots under
 * data/hosted/<uuid>/ are always copied.
 */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";
import { baseDataRoot } from "../config.ts";
import { runMigrations } from "../src/server/db.ts";
import { isOwnerId } from "../src/core/owner.ts";
import { normalizeEmail } from "../src/core/hosted-admission.ts";
import { sanitizeUserSettings } from "../src/core/settings.ts";
import { parseSourceOrganization } from "../src/core/source-organization.ts";
import { isBuiltinThemeId, isThemeId, sanitizeThemeFile } from "../src/core/themes.ts";
import { isValidSegmentPath } from "../src/core/prompt-segments.ts";
import { activeProblemOf, danglingQuestionOf } from "../src/core/native-messages.ts";
import { phaseAt3Lh, type Phase3 } from "../src/core/phases.ts";
import { CURRENT_CHAT_VERSION, type ImageSnapshot } from "../src/core/contracts.ts";
import { LOCAL_OWNER } from "../src/store/postgres/owner.ts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const COUNT_KEYS = [
	"chats", "snapshots", "nodes", "chains", "checkpoints", "coverage",
	"sources", "positions", "organization", "jobs", "settings", "themes", "overrides",
] as const;
type CountKey = (typeof COUNT_KEYS)[number];
type Counts = Record<CountKey, number>;
const zeroCounts = (): Counts => ({
	chats: 0, snapshots: 0, nodes: 0, chains: 0, checkpoints: 0, coverage: 0,
	sources: 0, positions: 0, organization: 0, jobs: 0, settings: 0, themes: 0, overrides: 0,
});

async function readJson(file: string): Promise<unknown> {
	try {
		return JSON.parse(await readFile(file, "utf8")) as unknown;
	} catch {
		return null; // absent or corrupt — the script refuses to guess
	}
}

async function readJsonl(file: string): Promise<unknown[]> {
	let raw: string;
	try {
		raw = await readFile(file, "utf8");
	} catch {
		return [];
	}
	const out: unknown[] = [];
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try { out.push(JSON.parse(trimmed) as unknown); } catch { /* torn line: skip */ }
	}
	return out;
}

async function jsonFiles(dir: string): Promise<string[]> {
	try {
		return (await readdir(dir)).filter((name) => name.endsWith(".json")).sort();
	} catch {
		return [];
	}
}

/** POSIX-relative .md overrides, mirroring the fs store's recursive walk. */
async function markdownFiles(dir: string, prefix = ""): Promise<Array<{ segment: string; file: string }>> {
	let entries: import("node:fs").Dirent[];
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const out: Array<{ segment: string; file: string }> = [];
	for (const entry of entries) {
		const segment = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.isDirectory()) {
			out.push(...await markdownFiles(path.join(dir, entry.name), segment));
		} else if (entry.isFile() && entry.name.endsWith(".md") && isValidSegmentPath(segment)) {
			out.push({ segment, file: path.join(dir, entry.name) });
		}
	}
	return out;
}

async function count(pool: Pool, table: string, owner: string): Promise<number> {
	const { rows } = await pool.query<{ count: string | number }>(
		`SELECT COUNT(*)::int AS count FROM ${table} WHERE owner_id = $1`,
		[owner],
	);
	return Number(rows[0]?.count ?? 0);
}

/** Derive the same lightweight columns createPostgresChatStore computes. */
function summaryOf(record: { title?: unknown; messages?: unknown; createdAt?: unknown; updatedAt?: unknown }) {
	const messages = Array.isArray(record.messages) ? record.messages : [];
	return {
		title: typeof record.title === "string" ? record.title : "Untitled session",
		createdAt: typeof record.createdAt === "string" ? record.createdAt : new Date(0).toISOString(),
		updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : new Date(0).toISOString(),
		messageCount: messages.length,
		phase: phaseAt3Lh(messages as never) as Phase3,
		pendingQuestion: danglingQuestionOf(messages as never) !== null,
		pendingProblem: activeProblemOf(messages as never) !== null,
	};
}

const INSERT_CHAT = `INSERT INTO chats
	(owner_id, id, title, kind, created_at, updated_at, version, message_count,
	 phase, pending_question, pending_problem, record)
	VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
	ON CONFLICT (owner_id, id) DO NOTHING`;

async function copyOwner(pool: Pool, owner: string, root: string): Promise<{ source: Counts; target: Counts }> {
	const source = zeroCounts();
	const graphDir = path.join(root, "graph");
	const client = await pool.connect();
	try {
		await client.query("BEGIN");

		// ── chats + image snapshots ─────────────────────────────────────────
		const chatsDir = path.join(root, "chats");
		for (const file of await jsonFiles(chatsDir)) {
			const parsed = await readJson(path.join(chatsDir, file));
			if (!isRecord(parsed) || typeof parsed.id !== "string" || !Array.isArray(parsed.messages)) continue;
			const s = summaryOf(parsed);
			const { imageSnapshots, ...stored } = parsed;
			await client.query(INSERT_CHAT, [
				owner, parsed.id, s.title, parsed.kind === "practice" ? "practice" : "teach",
				s.createdAt, s.updatedAt, typeof parsed.version === "number" ? parsed.version : CURRENT_CHAT_VERSION,
				s.messageCount, s.phase, s.pendingQuestion, s.pendingProblem, JSON.stringify(stored),
			]);
			source.chats++;
			if (isRecord(imageSnapshots)) {
				for (const [snapshotId, value] of Object.entries(imageSnapshots)) {
					if (!isRecord(value) || typeof value.data !== "string") continue;
					const image = value as unknown as ImageSnapshot;
					await client.query(
						`INSERT INTO chat_image_snapshots
						 (owner_id, chat_id, snapshot_id, mime_type, data, width, height)
						 VALUES ($1,$2,$3,$4,$5,$6,$7)
						 ON CONFLICT (owner_id, chat_id, snapshot_id) DO NOTHING`,
						[owner, parsed.id, snapshotId, String(image.mimeType ?? ""), image.data,
							Number(image.width ?? 0), Number(image.height ?? 0)],
					);
					source.snapshots++;
				}
			}
		}

		// ── append-only ledgers ─────────────────────────────────────────────
		// No unique key exists: the existing-count guard is the idempotency
		// mechanism. A re-run never double-appends a ledger.
		const ledgers = [
			{ key: "nodes", file: "nodes.jsonl", table: "graph_nodes", column: "id", lineKey: (r: Record<string, unknown>) => r.id },
			{ key: "chains", file: "chains.jsonl", table: "graph_chains", column: "id", lineKey: (r: Record<string, unknown>) => r.id },
			{ key: "checkpoints", file: "sessions.jsonl", table: "graph_checkpoints", column: "chat_id", lineKey: (r: Record<string, unknown>) => r.chatId },
			{ key: "coverage", file: "coverage.jsonl", table: "graph_coverage", column: "chat_id", lineKey: (r: Record<string, unknown>) => r.chatId },
		] as const;
		for (const ledger of ledgers) {
			const lines = (await readJsonl(path.join(graphDir, ledger.file))).filter(isRecord);
			source[ledger.key] = lines.length;
			if (await count(pool, ledger.table, owner) > 0) continue;
			for (const line of lines) {
				await client.query(
					`INSERT INTO ${ledger.table} (owner_id, ${ledger.column}, payload)
					 VALUES ($1, $2, $3::jsonb)`,
					[owner, String(ledger.lineKey(line) ?? ""), JSON.stringify(line)],
				);
			}
		}

		// ── map-shaped graph records ────────────────────────────────────────
		const sourcesMap = await readJson(path.join(graphDir, "sources.json"));
		if (isRecord(sourcesMap)) {
			for (const [id, value] of Object.entries(sourcesMap)) {
				if (!isRecord(value)) continue;
				await client.query(
					`INSERT INTO graph_sources (owner_id, id, payload) VALUES ($1,$2,$3::jsonb)
					 ON CONFLICT (owner_id, id) DO NOTHING`,
					[owner, id, JSON.stringify(value)],
				);
				source.sources++;
			}
		}

		const positions = await readJson(path.join(graphDir, "positions.json"));
		if (isRecord(positions) && isRecord(positions.positions)) {
			await client.query(
				`INSERT INTO graph_positions (owner_id, positions, updated_at) VALUES ($1,$2::jsonb,NOW())
				 ON CONFLICT (owner_id) DO NOTHING`,
				[owner, JSON.stringify(positions.positions)],
			);
			source.positions = 1;
		}

		const organization = await readJson(path.join(graphDir, "source-organization.json"));
		if (organization !== null) {
			try {
				const valid = parseSourceOrganization(organization);
				await client.query(
					`INSERT INTO source_organization (owner_id, state, updated_at) VALUES ($1,$2::jsonb,NOW())
					 ON CONFLICT (owner_id) DO NOTHING`,
					[owner, JSON.stringify(valid)],
				);
				source.organization = 1;
			} catch {
				console.warn(`  ${owner}: source-organization.json is invalid; skipped`);
			}
		}

		// ── jobs ────────────────────────────────────────────────────────────
		const jobsDir = path.join(root, "jobs");
		for (const file of await jsonFiles(jobsDir)) {
			const job = await readJson(path.join(jobsDir, file));
			if (!isRecord(job) || typeof job.id !== "string" || typeof job.chatId !== "string") continue;
			await client.query(
				`INSERT INTO jobs (owner_id, id, chat_id, tool_call_id, updated_at, payload)
				 VALUES ($1,$2,$3,$4,$5,$6::jsonb)
				 ON CONFLICT (owner_id, id) DO NOTHING`,
				[owner, job.id, job.chatId, String(job.toolCallId ?? ""),
					typeof job.updatedAt === "string" ? job.updatedAt : new Date(0).toISOString(),
					JSON.stringify(job)],
			);
			source.jobs++;
		}

		// ── settings / themes / prompt overrides ────────────────────────────
		const settings = sanitizeUserSettings(await readJson(path.join(root, "settings.json")));
		if (settings) {
			await client.query(
				`INSERT INTO user_settings (owner_id, settings, updated_at) VALUES ($1,$2::jsonb,NOW())
				 ON CONFLICT (owner_id) DO NOTHING`,
				[owner, JSON.stringify(settings)],
			);
			source.settings = 1;
		}

		const themesDir = path.join(root, "themes");
		for (const file of await jsonFiles(themesDir)) {
			const id = file.slice(0, -".json".length);
			if (!isThemeId(id) || isBuiltinThemeId(id)) continue;
			const theme = sanitizeThemeFile(await readJson(path.join(themesDir, file)));
			if (!theme) continue;
			await client.query(
				`INSERT INTO user_themes (owner_id, id, theme, updated_at) VALUES ($1,$2,$3::jsonb,NOW())
				 ON CONFLICT (owner_id, id) DO NOTHING`,
				[owner, id, JSON.stringify(theme)],
			);
			source.themes++;
		}

		const promptsDir = path.join(root, "prompts");
		for (const { segment, file } of await markdownFiles(promptsDir)) {
			let text: string;
			try { text = await readFile(file, "utf8"); } catch { continue; }
			await client.query(
				`INSERT INTO prompt_overrides (owner_id, segment_path, content, updated_at)
				 VALUES ($1,$2,$3,NOW())
				 ON CONFLICT (owner_id, segment_path) DO NOTHING`,
				[owner, segment, text],
			);
			source.overrides++;
		}

		await client.query("COMMIT");
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
	}

	const target: Counts = {
		chats: await count(pool, "chats", owner),
		snapshots: await count(pool, "chat_image_snapshots", owner),
		nodes: await count(pool, "graph_nodes", owner),
		chains: await count(pool, "graph_chains", owner),
		checkpoints: await count(pool, "graph_checkpoints", owner),
		coverage: await count(pool, "graph_coverage", owner),
		sources: await count(pool, "graph_sources", owner),
		positions: await count(pool, "graph_positions", owner),
		organization: await count(pool, "source_organization", owner),
		jobs: await count(pool, "jobs", owner),
		settings: await count(pool, "user_settings", owner),
		themes: await count(pool, "user_themes", owner),
		overrides: await count(pool, "prompt_overrides", owner),
	};
	return { source, target };
}

async function copyOperatorRecords(pool: Pool): Promise<void> {
	const root = baseDataRoot();
	const admissions = await readJson(path.join(root, "admissions.json"));
	if (isRecord(admissions) && Array.isArray(admissions.emails)) {
		for (const raw of admissions.emails) {
			const email = normalizeEmail(raw);
			if (!email) continue;
			await pool.query("INSERT INTO admissions (email) VALUES ($1) ON CONFLICT (email) DO NOTHING", [email]);
		}
	}
	const signups = await readJson(path.join(root, "signups.json"));
	if (isRecord(signups) && Array.isArray(signups.requests)) {
		for (const raw of signups.requests) {
			if (!isRecord(raw)) continue;
			const email = normalizeEmail(raw.email);
			if (!email) continue;
			await pool.query(
				`INSERT INTO signup_requests (email, requested_at) VALUES ($1,$2)
				 ON CONFLICT (email) DO NOTHING`,
				[email, typeof raw.requestedAt === "string" ? raw.requestedAt : new Date(0).toISOString()],
			);
		}
	}
	const credentials = await readJson(path.join(root, "issued-credentials.json"));
	if (Array.isArray(credentials)) {
		for (const raw of credentials) {
			if (!isRecord(raw) || typeof raw.email !== "string") continue;
			const email = normalizeEmail(raw.email);
			if (!email) continue;
			await pool.query(
				`INSERT INTO issued_credentials (email, payload, issued_at) VALUES ($1,$2::jsonb,$3)
				 ON CONFLICT (email) DO NOTHING`,
				[email, JSON.stringify(raw), typeof raw.issuedAt === "string" ? raw.issuedAt : new Date(0).toISOString()],
			);
		}
	}
}

async function main(): Promise<void> {
	const url = process.env.DATABASE_URL?.trim();
	if (!url) throw new Error("DATABASE_URL is required for the FS-to-Postgres copy.");
	const includeLegacy = process.argv.slice(2).includes("--include-legacy");
	const dataRoot = baseDataRoot();
	const hostedDir = path.join(dataRoot, "hosted");

	const pool = new Pool({ connectionString: url, max: 5, connectionTimeoutMillis: 5_000 });
	try {
		const applied = await runMigrations(pool);
		console.log(`Migrations applied: ${applied.length ? applied.join(", ") : "none (already current)"}`);

		let owners: string[] = [];
		try {
			owners = (await readdir(hostedDir, { withFileTypes: true }))
				.filter((entry) => entry.isDirectory() && isOwnerId(entry.name))
				.map((entry) => entry.name)
				.sort();
		} catch {
			// No hosted dir yet — nothing tenant-scoped to copy.
		}
		if (includeLegacy) owners.push(LOCAL_OWNER);
		console.log(`Owner roots to copy: ${owners.length ? owners.join(", ") : "none"}`);

		let mismatches = 0;
		for (const owner of owners) {
			const root = owner === LOCAL_OWNER ? dataRoot : path.join(hostedDir, owner);
			const { source, target } = await copyOwner(pool, owner, root);
			console.log(`\nOwner ${owner} (source: ${path.relative(process.cwd(), root) || "."})`);
			let bad = 0;
			for (const key of COUNT_KEYS) {
				const mark = source[key] === target[key] ? " " : "!";
				if (mark === "!") bad++;
				console.log(`  ${mark} ${key.padEnd(12)} source ${String(source[key]).padStart(5)}  postgres ${String(target[key]).padStart(5)}`);
			}
			if (bad > 0) {
				mismatches += bad;
				console.warn(`  ${bad} count(s) differ — see the '!' rows (existing PG rows are never overwritten).`);
			}
		}

		await copyOperatorRecords(pool);
		const [{ rows: admissions }, { rows: signups }, { rows: credentials }] = await Promise.all([
			pool.query<{ count: string | number }>("SELECT COUNT(*)::int AS count FROM admissions"),
			pool.query<{ count: string | number }>("SELECT COUNT(*)::int AS count FROM signup_requests"),
			pool.query<{ count: string | number }>("SELECT COUNT(*)::int AS count FROM issued_credentials"),
		]);
		console.log("\nOperator records in postgres:");
		console.log(`  admissions: ${Number(admissions[0]?.count ?? 0)}`);
		console.log(`  signups:    ${Number(signups[0]?.count ?? 0)}`);
		console.log(`  credentials:${Number(credentials[0]?.count ?? 0)}`);
		console.log(`\nDone. The local data tree at ${dataRoot} was never modified.`);
		if (mismatches > 0) {
			throw new Error(`${mismatches} source/Postgres count(s) differ; review the '!' rows above.`);
		}
	} finally {
		await pool.end();
	}
}

main().catch((error) => {
	console.error("[migrate-fs-to-postgres] failed:", error);
	process.exitCode = 1;
});
