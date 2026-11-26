/**
 * Pure admin usage statistics aggregation (operator dashboard).
 *
 * Browser-safe: no Node or database imports. Aggregates session counts and
 * token breakdowns across chat turns, background extraction runs, and
 * sub-agent jobs, optionally filtered by a rolling time window.
 */
import type { CallUsage, ExtractionRunUsage, JobUsage, TurnUsage } from "./contracts.ts";
import { normalizeEmail } from "./admission.ts";

export type AdminStatsRange = "all" | "30d" | "7d" | "24h";

export const ADMIN_STATS_RANGES: readonly { id: AdminStatsRange; label: string }[] = [
	{ id: "all", label: "All time" },
	{ id: "30d", label: "30d" },
	{ id: "7d", label: "7d" },
	{ id: "24h", label: "24h" },
];

const RANGE_MS: Record<Exclude<AdminStatsRange, "all">, number> = {
	"24h": 24 * 60 * 60 * 1000,
	"7d": 7 * 24 * 60 * 60 * 1000,
	"30d": 30 * 24 * 60 * 60 * 1000,
};

export function parseAdminStatsRange(value: string | string[] | undefined): AdminStatsRange {
	const raw = Array.isArray(value) ? value[0] : value;
	if (raw === "24h" || raw === "7d" || raw === "30d" || raw === "all") return raw;
	return "all";
}

export function rangeCutoffMs(range: AdminStatsRange, nowMs = Date.now()): number | null {
	if (range === "all") return null;
	return nowMs - RANGE_MS[range];
}

export interface TokenBreakdown {
	/** Fresh input + output + cacheRead + cacheWrite (Pi's disjoint buckets). */
	total: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** Subset of output tokens used for model reasoning/thinking. */
	reasoning: number;
}

export interface AdminUserStatsRow {
	userId: string | null;
	email: string;
	sessions: number;
	tokens: TokenBreakdown;
	lastActiveAt: string | null;
}

export interface AdminStatsSnapshot {
	available: boolean;
	range: AdminStatsRange;
	generatedAt: string;
	totals: {
		users: number;
		activeUsers: number;
		sessions: number;
		tokens: TokenBreakdown;
	};
	users: AdminUserStatsRow[];
}

export interface AdminStatsChatRow {
	ownerId: string;
	createdAt: string;
	updatedAt: string;
	turns?: readonly TurnUsage[] | null;
	extractions?: readonly ExtractionRunUsage[] | null;
}

export interface AdminStatsJobRow {
	ownerId: string;
	updatedAt: string;
	usage?: JobUsage | null;
}

export interface AdminStatsInput {
	users: readonly { id: string; email: string }[];
	admittedEmails?: readonly string[];
	chats: readonly AdminStatsChatRow[];
	jobs: readonly AdminStatsJobRow[];
}

export function emptyTokenBreakdown(): TokenBreakdown {
	return { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
}

function safeTokenCount(value: number | undefined): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

export function addCallUsage(target: TokenBreakdown, call: Partial<CallUsage> | null | undefined): void {
	if (!call) return;
	const input = safeTokenCount(call.inputTokens);
	const output = safeTokenCount(call.outputTokens);
	const cacheRead = safeTokenCount(call.cacheReadTokens);
	const cacheWrite = safeTokenCount(call.cacheWriteTokens);
	const reasoning = safeTokenCount(call.reasoningTokens);
	target.input += input;
	target.output += output;
	target.cacheRead += cacheRead;
	target.cacheWrite += cacheWrite;
	target.reasoning += reasoning;
	target.total += input + output + cacheRead + cacheWrite;
}

function addTokenBreakdown(target: TokenBreakdown, source: TokenBreakdown): void {
	target.input += source.input;
	target.output += source.output;
	target.cacheRead += source.cacheRead;
	target.cacheWrite += source.cacheWrite;
	target.reasoning += source.reasoning;
	target.total += source.total;
}

function parseTimestamp(value: string | undefined | null): number | null {
	if (!value) return null;
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? ms : null;
}

function withinCutoff(timestampMs: number | null, cutoffMs: number | null): boolean {
	if (cutoffMs === null) return true;
	return timestampMs !== null && timestampMs >= cutoffMs;
}

export function buildAdminStats(input: AdminStatsInput, range: AdminStatsRange, nowMs = Date.now()): AdminStatsSnapshot {
	const cutoffMs = rangeCutoffMs(range, nowMs);
	const byOwner = new Map<string, { row: AdminUserStatsRow; lastActiveMs: number | null }>();
	const seenEmails = new Set<string>();

	const ensureOwner = (ownerId: string): { row: AdminUserStatsRow; lastActiveMs: number | null } => {
		const key = ownerId.toLowerCase();
		const existing = byOwner.get(key);
		if (existing) return existing;
		const created = {
			row: {
				userId: key,
				email: ownerId,
				sessions: 0,
				tokens: emptyTokenBreakdown(),
				lastActiveAt: null,
			},
			lastActiveMs: null,
		};
		byOwner.set(key, created);
		return created;
	};

	const touchActive = (entry: { row: AdminUserStatsRow; lastActiveMs: number | null }, tsMs: number | null, iso: string) => {
		if (tsMs === null) return;
		if (entry.lastActiveMs === null || tsMs > entry.lastActiveMs) {
			entry.lastActiveMs = tsMs;
			entry.row.lastActiveAt = iso;
		}
	};

	for (const user of input.users) {
		const key = user.id.toLowerCase();
		const normalized = normalizeEmail(user.email) || user.email;
		seenEmails.add(normalized);
		byOwner.set(key, {
			row: {
				userId: key,
				email: normalized,
				sessions: 0,
				tokens: emptyTokenBreakdown(),
				lastActiveAt: null,
			},
			lastActiveMs: null,
		});
	}

	for (const chat of input.chats) {
		const entry = ensureOwner(chat.ownerId);
		const createdMs = parseTimestamp(chat.createdAt);
		const updatedMs = parseTimestamp(chat.updatedAt);

		if (withinCutoff(updatedMs, cutoffMs) || withinCutoff(createdMs, cutoffMs)) {
			entry.row.sessions += 1;
			if (withinCutoff(updatedMs, cutoffMs)) touchActive(entry, updatedMs, chat.updatedAt);
			else if (withinCutoff(createdMs, cutoffMs)) touchActive(entry, createdMs, chat.createdAt);
		}

		for (const turn of chat.turns ?? []) {
			const turnMs = parseTimestamp(turn.at);
			if (!withinCutoff(turnMs, cutoffMs)) continue;
			touchActive(entry, turnMs, turn.at);
			for (const step of turn.steps ?? []) {
				addCallUsage(entry.row.tokens, step);
			}
		}

		for (const extraction of chat.extractions ?? []) {
			const extractionMs = parseTimestamp(extraction.at);
			if (!withinCutoff(extractionMs, cutoffMs)) continue;
			touchActive(entry, extractionMs, extraction.at);
			for (const step of extraction.stages?.extractor?.steps ?? []) {
				addCallUsage(entry.row.tokens, step);
			}
			for (const step of extraction.stages?.auditor?.steps ?? []) {
				addCallUsage(entry.row.tokens, step);
			}
		}
	}

	for (const job of input.jobs) {
		const jobMs = parseTimestamp(job.updatedAt);
		if (!withinCutoff(jobMs, cutoffMs)) continue;
		const entry = ensureOwner(job.ownerId);
		touchActive(entry, jobMs, job.updatedAt);
		const usage = job.usage;
		if (!usage) continue;
		if (usage.calls && usage.calls.length > 0) {
			for (const call of usage.calls) addCallUsage(entry.row.tokens, call);
		} else {
			addCallUsage(entry.row.tokens, usage);
		}
	}

	const rows: AdminUserStatsRow[] = Array.from(byOwner.values(), (entry) => entry.row);

	for (const address of input.admittedEmails ?? []) {
		const normalized = normalizeEmail(address);
		if (!normalized || seenEmails.has(normalized)) continue;
		seenEmails.add(normalized);
		rows.push({
			userId: null,
			email: normalized,
			sessions: 0,
			tokens: emptyTokenBreakdown(),
			lastActiveAt: null,
		});
	}

	rows.sort((a, b) => {
		if (b.tokens.total !== a.tokens.total) return b.tokens.total - a.tokens.total;
		if (b.sessions !== a.sessions) return b.sessions - a.sessions;
		return a.email.localeCompare(b.email);
	});

	const totalTokens = emptyTokenBreakdown();
	let totalSessions = 0;
	let activeUsers = 0;
	for (const row of rows) {
		totalSessions += row.sessions;
		addTokenBreakdown(totalTokens, row.tokens);
		if (row.sessions > 0 || row.tokens.total > 0) activeUsers += 1;
	}

	return {
		available: true,
		range,
		generatedAt: new Date(nowMs).toISOString(),
		totals: {
			users: rows.length,
			activeUsers,
			sessions: totalSessions,
			tokens: totalTokens,
		},
		users: rows,
	};
}

export function formatCompactNumber(value: number): string {
	if (!Number.isFinite(value) || value === 0) return "0";
	const abs = Math.abs(value);
	if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2).replace(/\.?0+$/, "")}B`;
	if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M`;
	if (abs >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
	return value.toLocaleString("en-US");
}
