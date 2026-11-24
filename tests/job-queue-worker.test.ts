/**
 * Sub-agent jobs over the durable pg-boss queue (stack 5/7, 2026-11-24).
 *
 * With PostgreSQL storage the web process ENQUEUES research/demo/visual/pdf
 * loops and the standalone worker (scripts/worker.ts) runs them. These pins
 * cover the seams without a database: a fake PgBoss stands in for the queue.
 *
 *   1. dispatch: the job is enqueued with its owner, deduped by job id, and
 *      falls back to an in-process run when the queue is off or failing
 *   2. liveness: the queue reports created/retry/active jobs as pending, and
 *      the stale-job sweep never respawns a job the worker still holds
 *   3. delivery: in the worker a finished job never wakes a turn locally —
 *      the web process restores the pending delivery from the record
 *   4. cancel: the worker fires a live loop's kill switch once the record
 *      carries the learner's abort
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, describe, it, mock } from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-job-queue-worker-"));
process.env.LH_DATA_DIR = dataDir;
process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";

const { chatStore } = await import("../src/store/chats.ts");
const { jobStore } = await import("../src/store/jobs.ts");
const { runAsOwner } = await import("../src/core/owner-scope.ts");
const { buildSubagentSteer } = await import("../src/core/contracts.ts");
const { registerJobAbort, unregisterJobAbort, isJobLive } = await import("../src/agent/subagents/aborts.ts");
const queue = await import("../src/server/pg-queue.ts");
const jobs = await import("../src/server/jobs.ts");
const { jobRunner, spawnSubagentJob } = await import("../src/server/chat-handler.ts");
const { abortIfCancelled, runQueuedJob } = await import("../scripts/worker.ts");

const A = "9d0409ac-ee31-4944-8cc8-56ef5eb1bed5";

interface Sent { name: string; data: unknown; options: unknown }
interface FakeBoss { sent: Sent[]; send: (name: string, data: unknown, options: unknown) => Promise<string | null>; findJobs: (name: string, options: { key: string }) => Promise<Array<{ state: string }>> }

function installFakeBoss(overrides: Partial<FakeBoss> = {}): FakeBoss {
	const boss: FakeBoss = {
		sent: [],
		async send(name, data, options) { boss.sent.push({ name, data, options }); return "pgboss-id"; },
		async findJobs() { return []; },
		...overrides,
	};
	(globalThis as { __lhPgQueue?: unknown }).__lhPgQueue = boss;
	return boss;
}

function uninstallBoss(): void {
	delete (globalThis as { __lhPgQueue?: unknown }).__lhPgQueue;
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

afterEach(() => {
	mock.restoreAll();
	uninstallBoss();
	jobs.setRemoteJobDelivery(undefined);
	jobs.setRemoteJobLiveness(undefined);
});
after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

function resetSweepThrottle(): void {
	const g = globalThis as { __lhWakePipeline?: { lastSweepAt: Map<string, number> | number } };
	if (g.__lhWakePipeline) g.__lhWakePipeline.lastSweepAt = new Map();
}

async function runningJob(): Promise<{ chatId: string; jobId: string }> {
	const chat = await chatStore.createChat("Test: queued job");
	await chatStore.saveMessages(chat.id, [{ id: "u1", role: "user", content: "hello", timestamp: 1 } as never]);
	const job = await jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: `call-q-${Math.random().toString(36).slice(2)}` });
	return { chatId: chat.id, jobId: job.id };
}

// ─── 1. dispatch ──────────────────────────────────────────────────────────────

describe("spawnSubagentJob", () => {
	it("enqueues with the caller's owner and the job id as the singleton key", async () => {
		const boss = installFakeBoss();
		const inProcess = mock.method(jobRunner, "runJob", async () => {});
		runAsOwner(A, () => spawnSubagentJob("job_queued", { question: "why?" } as never));
		await tick();
		assert.equal(boss.sent.length, 1);
		assert.deepEqual(boss.sent[0], {
			name: queue.SUBAGENT_QUEUE,
			data: { owner: A, jobId: "job_queued", input: { question: "why?" } },
			options: { singletonKey: "job_queued" },
		});
		assert.equal(inProcess.mock.callCount(), 0, "the worker runs it, not this process");
	});

	it("runs in-process when the queue is not active (fs storage, tests, desktop)", async () => {
		const inProcess = mock.method(jobRunner, "runJob", async () => {});
		spawnSubagentJob("job_local");
		assert.equal(inProcess.mock.callCount(), 1);
		assert.equal(inProcess.mock.calls[0]!.arguments[0], "job_local");
	});

	it("falls back to an in-process run when enqueueing fails", async () => {
		installFakeBoss({ async send() { throw new Error("db down"); } });
		const inProcess = mock.method(jobRunner, "runJob", async () => {});
		mock.method(console, "error", () => {});
		spawnSubagentJob("job_fallback");
		await tick();
		await tick();
		assert.equal(inProcess.mock.callCount(), 1);
	});

	it("the crash-recovery respawn goes through the queue too", async () => {
		const boss = installFakeBoss();
		const { jobId } = await runningJob();
		resetSweepThrottle();
		await jobs.recoverStaleJobs();
		await tick();
		assert.ok(boss.sent.some((sent) => (sent.data as { jobId: string }).jobId === jobId), "the orphan is re-enqueued, not run here");
		await jobStore.updateJob(jobId, { status: "done", activity: "settled (test)" });
	});
});

// ─── 2. liveness ──────────────────────────────────────────────────────────────

describe("queue liveness", () => {
	it("created, retry and active jobs are pending; finished ones are not", async () => {
		const states: Record<string, string> = { a: "created", b: "retry", c: "active", d: "completed", e: "failed" };
		installFakeBoss({ async findJobs(_name, { key }) { return [{ state: states[key]! }]; } });
		assert.deepEqual(
			await Promise.all(["a", "b", "c", "d", "e"].map((key) => queue.subagentJobPending(key))),
			[true, true, true, false, false],
		);
	});

	it("is never pending without an active queue", async () => {
		assert.equal(await queue.subagentJobPending("anything"), false);
	});

	it("the sweep neither respawns nor relabels a job the worker still holds", async () => {
		const { jobId } = await runningJob();
		const respawned: string[] = [];
		jobs.setJobRespawn((id) => { respawned.push(id); });
		jobs.setRemoteJobLiveness(async (id) => id === jobId);
		resetSweepThrottle();
		await jobs.recoverStaleJobs();
		assert.ok(!respawned.includes(jobId));
		assert.equal((await jobStore.getJob(jobId))!.activity, "starting", "the record is untouched");
		await jobStore.updateJob(jobId, { status: "done", activity: "settled (test)" });
	});
});

// ─── 3. delivery ──────────────────────────────────────────────────────────────

describe("worker-side delivery", () => {
	it("hands the steer to the remote delivery and never queues a local wake", async () => {
		const { chatId, jobId } = await runningJob();
		const job = (await jobStore.getJob(jobId))!;
		const remote: string[] = [];
		jobs.setRemoteJobDelivery(async (steer) => { remote.push(steer.id); });
		let woke = 0;
		jobs.setTurnRunner(async () => { woke++; return 200; });
		const steer = buildSubagentSteer(job, { brief: "Done.", sources: [] });
		await jobs.deliverJobResult(steer);
		assert.deepEqual(remote, [steer.id]);
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal(woke, 0, "the worker never runs a lesson turn");
		jobs.discardChatDeliveries(chatId);
		await jobStore.updateJob(jobId, { status: "done", activity: "settled (test)" });
	});

	it("the web process restores a worker-finished job's pending delivery from the record", async () => {
		const { jobId, chatId } = await runningJob();
		// What the worker's runner persists before announcing the job.
		await jobStore.updateJob(jobId, {
			result: { brief: "Done: it works.", sources: [] }, status: "done", activity: "finished",
			delivery: { kind: "result", status: "pending" },
		});
		let fired = 0;
		jobs.setTurnRunner(async () => { fired++; return 200; });
		await jobs.resumeChatDelivery(chatId);
		const started = Date.now();
		while (fired === 0 && Date.now() - started < 8_000) await new Promise((resolve) => setTimeout(resolve, 25));
		assert.ok(fired > 0, "the wake fired in the web process");
		jobs.discardChatDeliveries(chatId);
	});
});

// ─── 4. cancel ────────────────────────────────────────────────────────────────

describe("worker cancel", () => {
	it("fires the live loop's kill switch once the record carries the learner's abort", async () => {
		const { jobId } = await runningJob();
		const controller = new AbortController();
		registerJobAbort(jobId, controller);
		await abortIfCancelled(jobId);
		assert.equal(controller.signal.aborted, false, "a running job is left alone");
		await jobStore.updateJob(jobId, { status: "error", error: "Aborted by learner", activity: "aborted", delivery: { kind: "abort", status: "pending" } });
		await abortIfCancelled(jobId);
		assert.equal(controller.signal.aborted, true);
		assert.equal(isJobLive(jobId), false);
		unregisterJobAbort(jobId);
	});

	it("never runs a second loop beside one this process is executing", async () => {
		const { jobId } = await runningJob();
		registerJobAbort(jobId, new AbortController());
		const run = mock.method(jobRunner, "runJob", async () => {});
		await runQueuedJob({ jobId });
		assert.equal(run.mock.callCount(), 0);
		unregisterJobAbort(jobId);
		await jobStore.updateJob(jobId, { status: "done", activity: "settled (test)" });
	});
});
