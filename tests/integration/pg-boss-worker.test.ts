/**
 * Real PostgreSQL 17 + pg-boss integration test:
 *   1. startJobQueue() initializes pg-boss schema and creates the exclusive
 *      sub-agent queue.
 *   2. enqueueSubagentJob() persists a job, deduplicates by singletonKey, and
 *      subagentJobPending() reports it as pending.
 *   3. A real pg-boss worker consumer claims and completes the job, after
 *      which subagentJobPending() becomes false.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { closePgPool, getPgPool, runMigrations } from "../../src/server/db.ts";
import {
	SUBAGENT_QUEUE,
	enqueueSubagentJob,
	isJobQueueActive,
	startJobQueue,
	stopJobQueue,
	subagentJobPending,
	type SubagentJobData,
} from "../../src/server/pg-queue.ts";

const DATABASE_URL = process.env.DATABASE_URL?.trim();
assert.ok(DATABASE_URL, "DATABASE_URL must be set for integration tests");

before(async () => {
	await runMigrations(getPgPool());
});

after(async () => {
	await stopJobQueue();
	await closePgPool();
});

describe("pg-boss durable sub-agent queue", () => {
	it("enqueues, deduplicates, claims, and completes a job against real Postgres", async () => {
		const boss = await startJobQueue(DATABASE_URL);
		assert.ok(boss, "pg-boss must start when DATABASE_URL and STORAGE_BACKEND=postgres are set");
		assert.equal(isJobQueueActive(), true);

		const jobId = `job_ci_${randomUUID().slice(0, 8)}`;
		const owner = randomUUID();

		const enqueued1 = await enqueueSubagentJob({ owner, jobId, input: { query: "test" } });
		assert.equal(enqueued1, true);
		assert.equal(await subagentJobPending(jobId), true);

		// Exclusive queue + singletonKey: re-enqueueing the same jobId is a safe no-op.
		const enqueued2 = await enqueueSubagentJob({ owner, jobId, input: { query: "duplicate" } });
		assert.equal(enqueued2, true);

		const claimed: SubagentJobData[] = [];
		const workerId = await boss.work<SubagentJobData>(
			SUBAGENT_QUEUE,
			{ pollingIntervalSeconds: 0.5 },
			async (jobs) => {
				for (const job of jobs) {
					if (job.data.jobId === jobId) {
						claimed.push(job.data);
					}
				}
			},
		);

		try {
			const deadline = Date.now() + 10_000;
			while (claimed.length === 0 && Date.now() < deadline) {
				await new Promise((r) => setTimeout(r, 100));
			}
			assert.equal(claimed.length, 1, "exactly one job should be claimed (singletonKey dedupe)");
			assert.equal(claimed[0]!.owner, owner);
			assert.equal(claimed[0]!.jobId, jobId);

			// Wait briefly for pg-boss to mark the job completed.
			const doneDeadline = Date.now() + 5_000;
			while ((await subagentJobPending(jobId)) && Date.now() < doneDeadline) {
				await new Promise((r) => setTimeout(r, 100));
			}
			assert.equal(await subagentJobPending(jobId), false);
		} finally {
			await boss.offWork(SUBAGENT_QUEUE, { id: workerId });
		}
	});
});
