/**
 * pg-boss durable job queue (PR 5). The web process ENQUEUES; the standalone
 * worker (scripts/worker.ts) CLAIMS and runs jobs with the owner carried on
 * the payload. Both queues are created idempotently (pg-boss's create_queue
 * is ON CONFLICT DO NOTHING), so a restart never loses a job.
 *
 * A missing DATABASE_URL or an explicit STORAGE_BACKEND=fs is a graceful
 * no-op: local development keeps the original in-process job runner and
 * does not need a database running.
 */

import { PgBoss } from "pg-boss";
import { postgresStorageEnabled } from "./stores.ts";
import { hasDatabaseUrl } from "./db.ts";

export const SUBAGENT_QUEUE = "lh:subagent-job";
export const EXTRACTION_QUEUE = "lh:extraction";

export interface SubagentJobData {
	owner: string;
	jobId: string;
	input?: unknown;
}

export interface ExtractionJobData {
	owner: string;
	chatId: string;
}

interface QueueGlobal {
	__lhPgQueue?: PgBoss;
}

function active(): PgBoss | undefined {
	return (globalThis as typeof globalThis & QueueGlobal).__lhPgQueue;
}

/** Start the producer-side queue. Returns the live PgBoss (the worker uses
 *  it to register its consumers), or null when the queue is disabled. */
export async function startJobQueue(connectionString?: string): Promise<PgBoss | null> {
	const g = globalThis as typeof globalThis & QueueGlobal;
	if (g.__lhPgQueue) return g.__lhPgQueue;
	const url = (connectionString ?? process.env.DATABASE_URL ?? "").trim();
	if (!url || !hasDatabaseUrl({ DATABASE_URL: url }) || !postgresStorageEnabled()) return null;

	const boss = new PgBoss(url);
	boss.on("error", (error) => console.warn("[pg-queue] pg-boss error:", error));
	await boss.start();
	await boss.createQueue(SUBAGENT_QUEUE);
	await boss.createQueue(EXTRACTION_QUEUE);
	g.__lhPgQueue = boss;
	return boss;
}

export function isJobQueueActive(): boolean {
	return active() !== undefined;
}

/** Lazily start so enqueue() works from any process before an explicit boot. */
async function ensureQueue(): Promise<PgBoss | null> {
	return active() ?? await startJobQueue();
}

export async function enqueueSubagentJob(data: SubagentJobData): Promise<void> {
	const boss = await ensureQueue();
	if (!boss) return;
	await boss.send(SUBAGENT_QUEUE, data);
}

export async function enqueueExtraction(data: ExtractionJobData): Promise<void> {
	const boss = await ensureQueue();
	if (!boss) return;
	await boss.send(EXTRACTION_QUEUE, data);
}

export async function stopJobQueue(): Promise<void> {
	const g = globalThis as typeof globalThis & QueueGlobal;
	const boss = g.__lhPgQueue;
	if (!boss) return;
	g.__lhPgQueue = undefined;
	await boss.stop({ graceful: true, timeout: 5_000 });
}
