/**
 * Standalone pg-boss worker (PR 5).
 *
 *   DATABASE_URL=postgresql://... node --env-file-if-exists=.env \
 *     node_modules/tsx/dist/cli.mjs --import tsx scripts/worker.ts
 *
 * Runs the sub-agent job loops (research / demo / visual / pdf) that the web
 * process enqueues whenever PostgreSQL storage is active. Each job runs inside
 * withOwner(owner, ...), the same AsyncLocalStorage scope a request
 * establishes, so every store call lands in the right tenant.
 *
 * The worker never wakes a lesson turn itself: the finished result and its
 * pending delivery are saved on the job record, then announced to the web
 * process (lh_job_delivery NOTIFY), which owns live agents and the turn pump.
 * A lost announcement is recovered by the web process's stale-job sweep.
 *
 * Cancel: the web process's abortJob flips the record to an abort delivery;
 * this worker polls its live jobs and fires the loop's AbortController.
 */

import { hasDatabaseUrl, getPgPool, runMigrations, closePgPool } from "../src/server/db.ts";
import { createPostgresStores } from "../src/store/postgres/index.ts";
import { configureStores, stores, withOwner } from "../src/server/stores.ts";
import { publishJobDelivery, startPgEventsBridge, stopPgEventsBridge } from "../src/server/pg-events.ts";
import {
	SUBAGENT_QUEUE,
	SUBAGENT_WORKER_CONCURRENCY,
	startJobQueue,
	stopJobQueue,
	type SubagentJobData,
} from "../src/server/pg-queue.ts";
import { setRemoteJobDelivery } from "../src/server/jobs.ts";
import { jobRunner } from "../src/server/chat-handler.ts";
import { fireJobAbort, isJobLive } from "../src/agent/subagents/aborts.ts";
import type { JobToolInput } from "../src/agent/subagents/runner.ts";

/** How often a running job's record is checked for a learner abort. */
const ABORT_POLL_MS = 3_000;

/** Fire the loop's kill switch once the web process has aborted the job. */
export async function abortIfCancelled(jobId: string): Promise<void> {
	if (!isJobLive(jobId)) return;
	const record = await stores.jobStore.getJob(jobId);
	if (record?.delivery?.kind === "abort") fireJobAbort(jobId);
}

/** Run one claimed job in its owner's scope, then announce its delivery. */
export async function runQueuedJob(data: SubagentJobData): Promise<void> {
	const { owner, jobId } = data;
	// Defense in depth: pg-boss's exclusive policy already prevents a second
	// claim, but never run a loop beside one this process is executing.
	if (isJobLive(jobId)) return;
	await withOwner(owner, async () => {
		const watch = setInterval(() => {
			void abortIfCancelled(jobId).catch((error: unknown) => console.warn(`[worker] abort check for ${jobId} failed:`, error));
		}, ABORT_POLL_MS);
		watch.unref?.();
		try {
			await jobRunner.runJob(jobId, data.input as JobToolInput | undefined);
		} finally {
			clearInterval(watch);
		}
		const record = await stores.jobStore.getJob(jobId);
		if (record) await publishJobDelivery({ ...(owner ? { owner } : {}), chatId: record.chatId });
	});
}

async function main(): Promise<void> {
	if (!hasDatabaseUrl()) {
		throw new Error("DATABASE_URL is required to run the worker.");
	}

	const pool = getPgPool();
	const applied = await runMigrations(pool);
	console.info(`[worker] migrations applied: ${applied.length ? applied.join(", ") : "none (already current)"}`);

	configureStores(createPostgresStores(pool));
	// Full bridge: the worker publishes its store events (job progress) to
	// the web process's SSE subscribers, and announces finished jobs.
	startPgEventsBridge();
	// The durable outcome is already saved; never wake a turn in the worker.
	setRemoteJobDelivery(async () => {});

	const boss = await startJobQueue();
	if (!boss) throw new Error("Job queue is disabled (STORAGE_BACKEND=fs or no DATABASE_URL).");

	await boss.work<SubagentJobData>(
		SUBAGENT_QUEUE,
		{ localConcurrency: SUBAGENT_WORKER_CONCURRENCY, batchSize: 1 },
		async (jobs) => {
			for (const job of jobs) await runQueuedJob(job.data);
		},
	);

	console.info(`[worker] ready — consuming ${SUBAGENT_QUEUE} (concurrency ${SUBAGENT_WORKER_CONCURRENCY})`);
}

let stopping = false;
async function shutdown(signal: string): Promise<void> {
	if (stopping) return;
	stopping = true;
	console.info(`[worker] ${signal} received; draining.`);
	try {
		await stopJobQueue();
		await stopPgEventsBridge();
		await closePgPool();
	} catch (error) {
		console.error("[worker] shutdown error:", error);
	}
	process.exit(0);
}

// Importable by tests without starting a worker.
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("scripts/worker.ts")) {
	process.on("SIGINT", () => void shutdown("SIGINT"));
	process.on("SIGTERM", () => void shutdown("SIGTERM"));
	main().catch((error) => {
		console.error("[worker] fatal:", error);
		process.exitCode = 1;
	});
}
