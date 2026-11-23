/**
 * pg-boss durable job queue (PR 5). The web process ENQUEUES sub-agent jobs
 * (research / demo / visual / pdf); the standalone worker (scripts/worker.ts)
 * CLAIMS and runs them with the owner carried on the payload, then announces
 * the finished job back to the web process over NOTIFY (pg-events.ts), which
 * performs the delivery — live agents and the turn pump live there.
 *
 * The queue is ACTIVE whenever PostgreSQL storage is (owner, 2026-11-24:
 * always-on, no separate switch). A missing DATABASE_URL or an explicit
 * STORAGE_BACKEND=fs is a graceful no-op: jobs then run in-process exactly
 * as before and no worker is needed.
 *
 * Graph extraction and plugin jobs are NOT queued: their in-memory status
 * and abort registries gate several web routes.
 */

import { PgBoss } from "pg-boss";
import { postgresStorageEnabled } from "./stores.ts";
import { hasDatabaseUrl } from "./db.ts";

/** pg-boss 12 names allow only [A-Za-z0-9_./-] — no colon. */
export const SUBAGENT_QUEUE = "lh-subagent-job";

/** Queue policy: one queued-or-active pg-boss job per LearnHarness job id
 *  (`exclusive` + singletonKey), so a respawn can never run a loop twice. */
export const SUBAGENT_QUEUE_OPTIONS = {
	policy: "exclusive",
	/** Hard ceiling for one sub-agent loop. */
	expireInSeconds: 3 * 60 * 60,
	/** One re-run after a crashed/expired attempt; the runner itself records
	 *  ordinary failures on the job record, so pg-boss rarely sees them. */
	retryLimit: 1,
	/** work() refreshes heartbeats; a dead worker's job is retried within
	 *  about a minute instead of waiting out expireInSeconds. */
	heartbeatSeconds: 60,
} as const;

/** How many sub-agent loops one worker process runs at once. */
export const SUBAGENT_WORKER_CONCURRENCY = 4;

export interface SubagentJobData {
	/** The job's owner; absent for unscoped (desktop/plain-dev) work. */
	owner?: string;
	jobId: string;
	input?: unknown;
}

interface QueueGlobal {
	__lhPgQueue?: PgBoss;
}

function active(): PgBoss | undefined {
	return (globalThis as typeof globalThis & QueueGlobal).__lhPgQueue;
}

/** Start the queue (idempotent). Returns the live PgBoss (the worker uses it
 *  to register its consumer), or null when the queue is disabled. */
export async function startJobQueue(connectionString?: string): Promise<PgBoss | null> {
	const g = globalThis as typeof globalThis & QueueGlobal;
	if (g.__lhPgQueue) return g.__lhPgQueue;
	const url = (connectionString ?? process.env.DATABASE_URL ?? "").trim();
	if (!url || !hasDatabaseUrl({ DATABASE_URL: url }) || !postgresStorageEnabled()) return null;

	const boss = new PgBoss(url);
	boss.on("error", (error) => console.warn("[pg-queue] pg-boss error:", error));
	await boss.start();
	// create_queue is ON CONFLICT DO NOTHING: a restart keeps every job.
	await boss.createQueue(SUBAGENT_QUEUE, SUBAGENT_QUEUE_OPTIONS);
	g.__lhPgQueue = boss;
	return boss;
}

/** True when THIS process should dispatch sub-agent jobs to the worker. */
export function isJobQueueActive(): boolean {
	return active() !== undefined;
}

/**
 * Enqueue one sub-agent job. Returns false when the queue is not active in
 * this process (the caller then runs the job in-process). A duplicate of a
 * job that is still queued/active is a silent no-op (singletonKey).
 */
export async function enqueueSubagentJob(data: SubagentJobData): Promise<boolean> {
	const boss = active();
	if (!boss) return false;
	await boss.send(SUBAGENT_QUEUE, data, { singletonKey: data.jobId });
	return true;
}

const PENDING_STATES = new Set(["created", "retry", "active"]);

/** Whether the queue still holds `jobId` (waiting, retrying or running). */
export async function subagentJobPending(jobId: string): Promise<boolean> {
	const boss = active();
	if (!boss) return false;
	const jobs = await boss.findJobs(SUBAGENT_QUEUE, { key: jobId });
	return jobs.some((job) => PENDING_STATES.has(String(job.state)));
}

export async function stopJobQueue(): Promise<void> {
	const g = globalThis as typeof globalThis & QueueGlobal;
	const boss = g.__lhPgQueue;
	if (!boss) return;
	g.__lhPgQueue = undefined;
	await boss.stop({ graceful: true, timeout: 5_000 });
}
