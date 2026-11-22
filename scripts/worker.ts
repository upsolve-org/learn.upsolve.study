/**
 * Standalone pg-boss worker (PR 5).
 *
 *   DATABASE_URL=postgresql://... node --env-file-if-exists=.env \
 *     node_modules/tsx/dist/cli.mjs --import tsx scripts/worker.ts
 *
 * Run one per deployment (or more — pg-boss coordinates claims in the DB).
 * It owns the durable queues for sub-agent jobs and graph extractions. Each
 * job runs inside withOwner(owner, ...), the same AsyncLocalStorage scope a
 * request establishes, so every store call lands in the right tenant.
 */

import { hasDatabaseUrl, getPgPool, runMigrations, closePgPool } from "../src/server/db.ts";
import { createPostgresStores } from "../src/store/postgres/index.ts";
import { configureStores, withOwner } from "../src/server/stores.ts";
import { startPgEventsBridge, stopPgEventsBridge } from "../src/server/pg-events.ts";
import {
	SUBAGENT_QUEUE,
	EXTRACTION_QUEUE,
	startJobQueue,
	stopJobQueue,
	type SubagentJobData,
	type ExtractionJobData,
} from "../src/server/pg-queue.ts";
import { jobRunner, extraction } from "../src/server/chat-handler.ts";

async function main(): Promise<void> {
	if (!hasDatabaseUrl()) {
		throw new Error("DATABASE_URL is required to run the worker.");
	}

	const pool = getPgPool();
	const applied = await runMigrations(pool);
	console.info(`[worker] migrations applied: ${applied.length ? applied.join(", ") : "none (already current)"}`);

	configureStores(createPostgresStores(pool));
	// Full bridge: the worker both publishes its own store events and receives
	// the web process's, so every SSE subscriber sees one coherent stream.
	startPgEventsBridge();

	const boss = await startJobQueue();
	if (!boss) throw new Error("Job queue is disabled (STORAGE_BACKEND=fs or no DATABASE_URL).");

	await boss.work<SubagentJobData>(SUBAGENT_QUEUE, async (jobs) => {
		for (const job of jobs) {
			const { owner, jobId, input } = job.data;
			await withOwner(owner, () => jobRunner.runJob(jobId, input as Parameters<typeof jobRunner.runJob>[1]));
		}
	});

	await boss.work<ExtractionJobData>(EXTRACTION_QUEUE, async (jobs) => {
		for (const job of jobs) {
			const { owner, chatId } = job.data;
			await withOwner(owner, () => extraction.runExtraction(chatId));
		}
	});

	console.info(`[worker] ready — consumers on ${SUBAGENT_QUEUE} and ${EXTRACTION_QUEUE}`);
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

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

main().catch((error) => {
	console.error("[worker] fatal:", error);
	process.exitCode = 1;
});
