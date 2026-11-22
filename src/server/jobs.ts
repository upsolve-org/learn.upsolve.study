/**
 * THE WAKE PIPELINE (contracts.ts "THE ASYNC PROTOCOL" §4) — server-side
 * steer delivery for finished sub-agent jobs. Wave C (2026-09-26):
 * delivery rides pi's OWN steering queue when a run is live, and the
 * idle wake otherwise. One registry, two vehicles.
 *
 *   deliverJobResult(steer) — the runner calls this on job completion.
 *     The steer joins a per-chat serialized registry and the pump drives
 *     it along ONE of two paths:
 *
 *       1. LIVE RUN → pi steering: the marker is handed to the LIVE
 *          agent's steering queue (agent.steer). pi polls that queue at
 *          TURN BOUNDARIES — after a completed assistant message AND its
 *          tool results (never between a toolCall and its result), and
 *          again at the run's start (a continuation drains the queue
 *          BEFORE its first LLM call) — and CONTINUES THE SAME RUN: the
 *          marker joins the context mid-lesson, rides the live event
 *          stream (message_start/message_end), and lands in the record
 *          at that run's persist. This is the owner's 2026-09-26
 *          correction: a real lesson is one continuous teach→quiz→teach
 *          loop, so delivery must happen BETWEEN messages inside the
 *          run — waiting for the run to stop (follow-ups) only ever
 *          fires at a stopper exit, which is exactly when it must not.
 *          The question stopper runs BEFORE the post-turn poll and
 *          exits the loop, so a quiz-terminated run never injects: the
 *          handed marker strands (see settleSteers) and waits — the
 *          ANSWER run then picks it up at its start poll. probe-handoff
 *          markers NEVER take this path (owner ruling: the handoff must
 *          start the TEACHER's run — a record-level branch only a fresh
 *          wake can make).
 *       2. IDLE WAKE: no live turn. WAIT FOR IDLE (turn-liveness OR a
 *          dangling question — an unanswered client-side tool call breaks
 *          provider conversion), then fire ONE server-side wake turn
 *          carrying EVERY queued marker as its input appends (write-ahead
 *          persist, liveness, extraction — one code path, the same
 *          composition as a client request). A 409 means a client turn
 *          raced in — re-queue and retry with backoff. Idempotent per
 *          jobId (steerDelivered): a crashed wake or a duplicate deliver
 *          is skipped, not duplicated.
 *
 *   settleSteers(chatId, persisted) — the handler calls this at turn
 *     settlement (after unregisterLiveAgent): entries the run DELIVERED
 *     resolve + acknowledge delivery; entries handed to the dying
 *     run but never injected (stopper exit, abort, a missed final poll)
 *     return to pending and the pump restarts — no stranding, no loss.
 *
 *   Worker status ends at computation completion; JobRecord.delivery owns
 *     pending notices independently. Registry entries survive in-flight
 *     wakes, so duplicates share one promise. Failed starts remain pending
 *     without worker errors. Recovery restores known pending deliveries and
 *     re-spawns unfinished BUILTIN workers only. Plugin recovery reads
 *     canonical task records through an injected seam, never replaying
 *     plugin code. Legacy terminal jobs without delivery metadata are not replayed.
 *
 * All mutable state lives on globalThis (the turn-liveness lesson: Next dev
 * gives each route entry its own module instances — a module-level Map would
 * be a different object in each).
 */

import {
	buildAbortSteer,
	buildJobFailureSteer,
	buildSubagentSteer,
	isSubagentFailure,
	steerDelivered,
	type ChatRecord,
	type JobRecord,
	type SteerMessage,
} from "../core/contracts.ts";
import type { TurnInput, UserSteerInput } from "../core/input-events.ts";
import { hasUnresolvedQuestion, endsInDismissal, endsInQuestionRecovery, newUserSteer, type LhMessage } from "../core/native-messages.ts";
import { prepareSubmissionImages, submissionImagePolicyKey } from "./submission-images.ts";
import { fireJobAbort, isJobLive } from "../agent/subagents/aborts.ts";
import { stores } from "./stores.ts";
import type { MaybePromise } from "../core/ports.ts";
import { resolveConversationSpec, resolveSettings } from "../core/settings-resolution.ts";
import { connectionBackgroundAllowed, isSubscriptionProvider, onSubscriptionChange } from "../agent/subscription-connections.ts";
import { isTurnRunning } from "./turn-liveness.ts";
import { currentOwnerId, runAsOwner } from "../core/owner-scope.ts";
import type { Agent } from "@earendil-works/pi-agent-core";

/** Fires one server-side teacher turn: (chatId, input) → HTTP-ish status.
 *  Wave C: the input is the IDLE WAKE — every queued marker as the turn's
 *  input appends (the handler appends them natively under the wake's own
 *  turn claim; one composition for every turn). */
export type TurnRunner = (chatId: string, input: TurnInput) => Promise<number>;

/** Re-runs a job's sub-agent loop (crash recovery for orphaned jobs). */
export type JobRespawn = (jobId: string) => void;
export type PluginJobRecovery = (job: JobRecord) => Promise<void>;
export function setPluginJobRecovery(recover: PluginJobRecovery): void {
	state().recoverPlugin = recover;
}

interface QueuedSteer {
	steer: SteerMessage;
	promise: Promise<void>;
	/** TENANCY (2026-11-16): the raw chat id and the owner the delivery
	 *  belongs to, captured when it is queued. The pump outlives the request
	 *  that queued it, so both travel with the entry rather than being
	 *  re-derived from ambient state. */
	chatId: string;
	owner?: string;
	/** Wake cargo remains owned here, but must not steer into its own run. */
	waking?: boolean;
	/** The constructed vehicle, once startup claims a turn. Until then only
	 * the pump owns waking: an unrelated foreground settlement cannot free it. */
	wakeAgent?: Agent;
	/** A failed start waits for a learner run or process restart, not a timer. */
	deferred?: boolean;
	resolve: () => void;
	reject: (reason: Error) => void;
	/** The live agent this marker was steered into (agent.steer) — set by
	 *  the hand-off helper. Guards double-handoff (a re-pumped loop or a
	 *  re-registered run must not re-queue what a run already holds) and is
	 *  CLEARED at settlement for markers the dying run never injected. */
	handedTo?: Agent;
}

interface WakeState {
	turnRunner?: TurnRunner;
	respawn?: JobRespawn;
	recoverPlugin?: PluginJobRecovery;
	/** chatId → steers awaiting delivery, in arrival order. The single
	 *  delivery registry (Wave C: the agent's own follow-up queue is a
	 *  per-run VEHICLE, not the registry — settlement reconciles here). */
	queues: Map<string, QueuedSteer[]>;
	/** chatId → user-steered messages awaiting drain (composer steering,
	 *  2026-10-03). Same deliver-or-requeue lifecycle as job markers: the
	 *  live agent's steering queue is the VEHICLE, this is the registry —
	 *  a steer stranded behind a question or an abort stays parked here
	 *  and rides the chat's NEXT run (handOffEligible). */
	userSteers: Map<string, UserSteerEntry[]>;
	/** chatId → the agent of the CURRENTLY streaming turn (cleared at
	 *  settlement, before settleSteers). The pump's live path hands
	 *  markers to this agent's follow-up queue. */
	liveAgents: Map<string, Agent>;
	/** In-flight deliverJobResult promises, keyed by steer id. Resolving a
	 *  job's chat is async under a real backend, so duplicate callers must
	 *  share one deferred promise (the registry's idempotence contract). */
	deliveries: Map<string, Promise<void>>;
	/** Chats whose pump loop is currently active (serialization per chat). */
	pumping: Set<string>;
	/** Throttle bookkeeping for the stale-job sweep, per owner (tenancy). */
	lastSweepAt: Map<string, number>;
	stopConnectionWatch?: () => void;
	automaticDeferred: WeakSet<Agent>;
}

interface LhWakeGlobal {
	__lhWakePipeline?: WakeState;
}

function state(): WakeState {
	const g = globalThis as typeof globalThis & LhWakeGlobal;
	return (g.__lhWakePipeline ??= { queues: new Map(), liveAgents: new Map(), userSteers: new Map(), deliveries: new Map(), pumping: new Set(), lastSweepAt: new Map(), automaticDeferred: new WeakSet() });
}

/** TENANCY (2026-11-16): `owner:chatId` — the same composite key every other
 *  registry uses, so two owners' sessions never share delivery state. */
function key(chatId: string): string {
	const owner = currentOwnerId();
	return owner ? `${owner}:${chatId}` : chatId;
}

/** chat-handler wires this at module init: its adapter around handleChatRequest. */
export function setTurnRunner(run: TurnRunner): void {
	state().turnRunner = run;
}

/** chat-handler wires this at module init: its job runner's runJob. */
export function setJobRespawn(respawn: JobRespawn): void {
	state().respawn = respawn;
}

const POLL_MS = 400;
/** After the gates open, wait a beat before firing — a client that just
 *  answered a question is about to send its continuation; don't 409 it.
 *
 *  Evidence for 750: the race window is exactly the learner's answer→POST
 *  flight — sendAutomaticallyWhen dispatches synchronously on addToolOutput,
 *  the answer hits the record only at the write-ahead persist, and beginTurn
 *  flips the turn registry immediately after, all before the grace can fire
 *  (measured localhost RTT ~10ms; typical LAN/production RTT <300ms). 750ms
 *  is 2.5× the worst realistic flight. A miss self-heals: the pump rechecks
 *  the gates after the grace AND the wake pipeline retries 409s with a
 *  backoff ramp — and since the transport's merge-retry (chat-transport.ts)
 *  made client 409s non-fatal, even a pathological RTT degrades gracefully.
 *  (Was 1500 — pure guess; 750 claws back 750ms of post-answer delivery
 *  latency without weakening the guard.) */
const GRACE_MS = 750;
/** 409 backoff: capped ramp so a busy client can't spin the pump. */
const RETRY_BACKOFF_MS = [500, 1000, 2000, 5000] as const;

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The job a steer belongs to, if it is a job steer (result/abort);
 *  probe-handoff steers have no job — null. */
function jobIdOf(steer: SteerMessage): string | null {
	const details = steer.details as { jobId?: string } | undefined;
	return typeof details?.jobId === "string" ? details.jobId : null;
}

/** True for a thenable port result (async backend under Postgres). */
function isPromiseLike<T>(value: MaybePromise<T>): value is Promise<T> {
	return value !== null && typeof value === "object" && typeof (value as Promise<T>).then === "function";
}

/** Continue with `next` once `value` settles. A synchronous value runs
 *  `next` INLINE: today's fs adapters must keep the synchronous bookkeeping
 *  the registry contract relies on, while an async adapter never throws. */
function onReady<T>(value: MaybePromise<T>, next: (value: T) => void, onError: (error: unknown) => void): void {
	if (isPromiseLike(value)) void value.then(next, onError);
	else { try { next(value); } catch (error) { onError(error); } }
}

/** Call only after canonical conversation persistence. Streaming visibility
 * is not durable acceptance. The saved marker wins over delivery-bookkeeping
 * failures; acknowledging delivery never changes the worker's outcome. */
export function noteSteersDurable(chatId: string, persisted: readonly LhMessage[]): void {
	for (const message of persisted) {
		if (message.role === "custom") finalizeSteer(message);
	}
	for (const entry of [...(state().queues.get(key(chatId)) ?? [])]) {
		if (persisted.some((message) => message.id === entry.steer.id)) completeEntry(chatId, entry);
	}
}

function removeEntry(chatId: string, entry: QueuedSteer): void {
	const remaining = (state().queues.get(key(chatId)) ?? []).filter((candidate) => candidate !== entry);
	if (remaining.length > 0) state().queues.set(key(chatId), remaining);
	else state().queues.delete(key(chatId));
}

function completeEntry(chatId: string, entry: QueuedSteer): void {
	finalizeSteer(entry.steer);
	removeEntry(chatId, entry);
	entry.resolve();
}

/** Deletion discards the session's obligations, never wakes a deleted chat. */
export function discardChatDeliveries(chatId: string): void {
	const s = state();
	const queue = s.queues.get(key(chatId)) ?? [];
	s.queues.delete(key(chatId));
	s.userSteers.delete(key(chatId));
	for (const entry of queue) entry.resolve();
}

/** Finalize a delivered steer's job bookkeeping — job steers only. */
function finalizeSteer(steer: SteerMessage): void {
	const jobId = jobIdOf(steer);
	// Bookkeeping off a sync event hook: the save itself is fire-and-forget,
	// and finalizeJob observes its own failures so no rejection escapes.
	if (jobId) void finalizeJob(jobId);
}

/** Queue one logical delivery per ID, including in-flight wake cargo.
 * Job promises resolve on durable marker acceptance (or session deletion);
 * failed starts stay pending. Non-job probe handoffs keep their existing
 * wake-acceptance/error semantics. Workers never await this promise. */
export function deliverJobResult(steer: SteerMessage): Promise<void> {
	const chatId = chatIdOf(steer);
	if (!isPromiseLike(chatId)) {
		// Sync adapters: identical to the historical path — one registry
		// entry, stable promise identity for duplicate callers.
		const entry = queueSteer(chatId, steer);
		void pump(chatId);
		return entry.promise;
	}
	// Async backend: resolving the job's chat is a read, so duplicate callers
	// share one deferred promise until the registry entry exists.
	const s = state();
	const shared = s.deliveries.get(steer.id);
	if (shared) return shared;
	const promise = chatId.then((id) => {
		const entry = queueSteer(id, steer);
		void pump(id);
		return entry.promise;
	}).finally(() => { s.deliveries.delete(steer.id); });
	s.deliveries.set(steer.id, promise);
	void promise.catch(() => undefined);
	return promise;
}

function queueSteer(chatId: string, steer: SteerMessage): QueuedSteer {
	const queue = state().queues.get(key(chatId)) ?? [];
	const existing = queue.find((entry) => entry.steer.id === steer.id);
	if (existing) return existing;
	let resolve!: () => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
	// Recovery/registration may own an entry with no waiting caller.
	void promise.catch(() => undefined);
	const entry: QueuedSteer = { steer, promise, chatId, owner: currentOwnerId(), resolve, reject };
	queue.push(entry);
	state().queues.set(key(chatId), queue);
	return entry;
}

/** Hand every eligible pending marker to a live agent's steering queue
 *  (idempotent per agent via handedTo). Called from BOTH the pump's live
 *  path and registerLiveAgent — a parked marker (stranded behind a quiz)
 *  must not wait for the pump loop to notice the new run: the handler
 *  registers the answer run's agent BEFORE runPiTurn, so this hand-off
 *  beats the loop's synchronous start-poll drain and the marker rides the
 *  run's FIRST LLM call (the native equivalent of the old continuation
 *  coalescing). */
export function automaticFollowUpAllowed(_chatId: string, agent?: Agent): boolean {
	if (agent && state().automaticDeferred.has(agent)) return false;
	// Sync seams (live hand-off, consent watch) must never touch storage: a
	// live agent carries its own provider, and an async adapter cannot be
	// awaited here. With no provider the connection gate answers its honest
	// default (BYOK allowed) — the pump's async form below resolves the real
	// conversation chain when there is no live agent.
	return connectionBackgroundAllowed(agent?.state?.model?.provider);
}

/** The pump (and other async seams) can resolve the chat's conversation
 *  chain when no live agent supplies a provider. Same consent gate, no
 *  synchronous store reads. */
export async function automaticFollowUpAllowedAsync(chatId: string, agent?: Agent): Promise<boolean> {
	if (agent && state().automaticDeferred.has(agent)) return false;
	const provider = agent?.state?.model?.provider ?? resolveConversationSpec(
		(await stores.chatStore.getChat(chatId))?.settings,
		resolveSettings(await stores.settingsStore.readSettings()).models.strong,
	)?.provider;
	return connectionBackgroundAllowed(provider);
}

function handOffEligible(chatId: string, agent: Agent): void {
	const queue = state().queues.get(key(chatId));
	// Keep automatic results in their owning registry. Never mix them into a
	// foreground batch without express account consent. Learner steers below
	// remain deliverable, including the first poll of an answer run.
	if (automaticFollowUpAllowed(chatId, agent) && queue && queue.length > 0) {
		for (const entry of queue) {
			if (!entry.waking && !entry.deferred && entry.handedTo !== agent && entry.steer.customType !== "probe-handoff") {
				agent.steer(entry.steer);
				entry.handedTo = agent;
			}
		}
	}
	// User steers (2026-10-03): same hand-off, any live run — a steer
	// stranded behind a question or abort rides the chat's next run's
	// first boundary. No probe-handoff exclusion: these are learner
	// words, owed to whatever run is live.
	const userQueue = state().userSteers.get(key(chatId));
	if (userQueue && userQueue.length > 0) {
		for (const entry of userQueue) {
			if (entry.handedTo !== agent) {
				agent.steer(entry.message);
				entry.handedTo = agent;
			}
		}
	}
}

/** The chat-handler registers the CURRENTLY STREAMING turn's agent BEFORE
 *  runPiTurn (the loop's start steering-poll drains synchronously inside
 *  that call — a later registration would miss it). Pending registry
 *  markers are steered into the run right here. The settle seam cannot
 *  beat the registration: settlement needs a streamed response, which
 *  never happens inside the constructor call. */
export function registerLiveAgent(chatId: string, agent: Agent, allowDeferred = true, wakeSteerIds?: ReadonlySet<string>): void {
	state().liveAgents.set(key(chatId), agent);
	restorePendingDeliveries(chatId);
	for (const entry of state().queues.get(key(chatId)) ?? []) {
		if (allowDeferred) entry.deferred = false;
		if (entry.waking && wakeSteerIds?.has(entry.steer.id)) entry.wakeAgent = agent;
	}
	handOffEligible(chatId, agent);
}

/** A parked user steer: the message plus the agent it was last handed to
 *  (the double-handoff guard — a reconcile keeps it only when its id
 *  never landed in the persisted record). */
export interface UserSteerEntry {
	message: LhMessage;
	handedTo?: Agent;
}

/** Async composer admission keeps the live agent private. Future chat settings
 * are deliberately irrelevant: this steer belongs to the captured live run.
 * Settling keeps the existing send fallback; replacements must never retarget. */
export async function prepareAndSteerChat(chatId: string, input: UserSteerInput): Promise<"accepted" | "settled" | "stale"> {
	const agent = state().liveAgents.get(key(chatId));
	if (!agent) return "settled";
	const model = agent.state.model;
	const session = await stores.chatStore.getChat(chatId);
	if (!model || !session) return "stale";
	const policy = submissionImagePolicyKey({ model });
	const { text, id } = input;
	const images = await prepareSubmissionImages(input.images, { model });
	const currentSession = await stores.chatStore.getChat(chatId);
	if (!currentSession || currentSession.createdAt !== session.createdAt || currentSession.kind !== session.kind) return "stale";
	const current = state().liveAgents.get(key(chatId));
	if (!current) return "settled";
	if (current !== agent || current.state.model !== model || submissionImagePolicyKey({ model }) !== policy) return "stale";
	// No await may separate the identity/policy check from this registry handoff.
	return steerLiveChat(chatId, newUserSteer(text, id, images)) ? "accepted" : "settled";
}

/** Synchronous live handoff. The registry copy preserves the existing
 * memory-only stranding safety net: undelivered steers ride the next run.
 * No live agent means the caller may fall back to an ordinary send. */
export function steerLiveChat(chatId: string, message: LhMessage): boolean {
	const agent = state().liveAgents.get(key(chatId));
	if (!agent) return false;
	const entry: UserSteerEntry = { message };
	const q = state().userSteers.get(key(chatId)) ?? [];
	q.push(entry);
	state().userSteers.set(key(chatId), q);
	agent.steer(message);
	entry.handedTo = agent;
	return true;
}

/** TURN SETTLEMENT RECONCILIATION for user steers: delivered ids drop
 *  (the record holds them); undelivered stay parked for the next run.
 *  Memory-only by design (same tradeoff as job markers): a server
 *  restart drops parked steers — and the whole turn dies with it anyway. */
export function reconcileUserSteers(chatId: string, persisted: readonly LhMessage[]): void {
	const q = state().userSteers.get(key(chatId));
	if (!q || q.length === 0) return;
	const ids = new Set(persisted.map((m) => (m as { id?: string }).id));
	const kept = q.filter((e) => !ids.has(e.message.id));
	if (kept.length === 0) state().userSteers.delete(key(chatId));
	else state().userSteers.set(key(chatId), kept);
}

/** Clear the live agent at settlement — MUST run before settleSteers so the
 *  reconciliation's re-pump can never hand a marker to the dying agent. */
export function unregisterLiveAgent(chatId: string): void {
	const agent = state().liveAgents.get(key(chatId));
	if (agent) state().automaticDeferred.delete(agent);
	state().liveAgents.delete(key(chatId));
}

/** Restore exact registry objects after native drain but before dispatch.
 * The vehicle is disposable; result ownership/promises are not. */
export function restoreUncommittedAutomatic(chatId: string, agent: Agent, automaticIds: ReadonlySet<string>, retainedIds: ReadonlySet<string>): void {
	const s = state();
	s.automaticDeferred.add(agent);
	for (const entry of s.queues.get(key(chatId)) ?? []) {
		if (entry.handedTo === agent && automaticIds.has(entry.steer.id)) entry.handedTo = undefined;
	}
	agent.clearSteeringQueue();
	for (const entry of s.userSteers.get(key(chatId)) ?? []) {
		if (!retainedIds.has(entry.message.id)) { agent.steer(entry.message); entry.handedTo = agent; }
	}
}

/** TURN SETTLEMENT RECONCILIATION (Wave C): the handler calls this AFTER
 * unregisterLiveAgent, with the run's persisted messages. Two jobs:
 *
 *   - entries whose marker the run DELIVERED (in-run follow-up injection —
 *     their ids are in the persisted slice) resolve and acknowledge delivery;
 *   - entries handed to the dying run but never injected (the question
 *     stopper exited before the follow-up poll; an abort; a delivery that
 *     raced the final poll) return to PENDING (handedTo cleared) and the
 *     pump restarts — the idle wake delivers them once the gates open.
 *
 * This is what makes the live hand-off safe: pi owns no retry for a marker
 * stranded in a settled agent's queue, so the registry stays the truth and
 * the dead agent's copy is simply abandoned (GC'd with the agent). */
export function settleSteers(chatId: string, persisted: { id?: string }[], failed = false, settledAgent?: Agent): void {
	const queue = state().queues.get(key(chatId));
	if (!queue || queue.length === 0) return;
	const deliveredIds = new Set(persisted.map((m) => m.id).filter(Boolean));
	const remaining: QueuedSteer[] = [];
	for (const entry of queue) {
		if (deliveredIds.has(entry.steer.id)) {
			finalizeSteer(entry.steer);
			entry.resolve();
		} else {
			const handedHere = entry.handedTo !== undefined && (!settledAgent || entry.handedTo === settledAgent);
			const wakeHere = settledAgent !== undefined && entry.wakeAgent === settledAgent;
			if (handedHere) entry.handedTo = undefined;
			if (wakeHere) { entry.waking = false; entry.wakeAgent = undefined; }
			if (failed && (handedHere || wakeHere) && jobIdOf(entry.steer)) entry.deferred = true;
			remaining.push(entry);
		}
	}
	if (remaining.length === 0) state().queues.delete(key(chatId));
	else {
		state().queues.set(key(chatId), remaining);
		void pump(chatId);
	}
}

/** Result of an abort attempt — the endpoint maps these to HTTP. */
export interface AbortOutcome {
	ok: boolean;
	reason?: "not_found" | "not_running";
}

/**
 * ABORT (2026-09 dock semantics, user-decided): real kill, error with
 * reason, the teacher still learns. The dock's END button reaches this
 * through POST /api/activity/abort (body {kind: "job", id: jobId}); the
 * route is master's thin composition — this is the job-side mechanism.
 * Completed computation cannot be aborted: its pending result belongs to
 * the session. For unfinished computation, save error "Aborted by learner"
 * and its pending abort notice BEFORE firing synchronous worker callbacks.
 * Then kill the registered worker and queue the deterministic abort marker.
 * Delivery acknowledgement never overwrites the computation outcome.
 *
 * The runner writes the usage folded so far in its finally (merge patch),
 * so an aborted job's money record survives the kill.
 */
export async function abortJob(jobId: string): Promise<AbortOutcome> {
	const job = await stores.jobStore.getJob(jobId);
	if (!job) return { ok: false, reason: "not_found" };
	if (job.status !== "running") return { ok: false, reason: "not_running" };
	if (job.result) {
		await normalizeLegacyResult(job);
		return { ok: false, reason: "not_running" };
	}

	await stores.jobStore.updateJob(jobId, {
		status: "error", error: "Aborted by learner", activity: "aborted",
		delivery: { kind: "abort", status: "pending" },
	});
	fireJobAbort(jobId);
	void deliverJobResult(buildAbortSteer(job)).catch(() => {
		/* The saved pending abort notice remains owned by the session. */
	});
	return { ok: true };
}

function chatIdOf(steer: SteerMessage): MaybePromise<string> {
	// The probe handoff carries its chat directly in the marker details (the
	// job record would say it too, but the details are the cheap path).
	if (steer.customType === "probe-handoff") {
		return (steer.details as { chatId: string }).chatId;
	}
	// The chat is resolvable from the job record; the steer's details
	// carry jobId, which indexes the store (may be async under Postgres).
	const jobId = jobIdOf(steer);
	if (!jobId) return "";
	const job = stores.jobStore.getJob(jobId);
	return isPromiseLike(job) ? job.then((record) => record?.chatId ?? "") : job?.chatId ?? "";
}

/**
 * The per-chat pump: delivers the registry along pi's two native paths.
 * Only one loop per chat at a time; later arrivals ride the registry.
 *
 * Each iteration first clears dead weight (gone chat, already-delivered
 * markers), then picks the vehicle: a LIVE turn takes every eligible
 * marker via agent.followUp (the run continues at its own stop — nothing
 * more to do here until settlement re-pumps); otherwise the IDLE WAKE
 * fires ONE turn carrying every pending marker as its input appends.
 */
/**
 * TENANCY (2026-11-16): the pump is long-lived and detached from any request,
 * so it re-enters the owner scope of the cargo it delivers. The owner comes
 * from the queue entry (captured at enqueue), never from ambient state. A
 * queue whose entries carry no owner is unscoped legacy work.
 */
/**
 * TENANCY (2026-11-16): the pump is long-lived and detached from any request,
 * so it re-enters the owner scope of the cargo it delivers. The owner comes
 * from the queue entry (captured at enqueue), never from ambient state.
 *
 * Callers pass a RAW chat id. The registry key is always derived inside the
 * scope, so a caller that happens to be unscoped cannot produce a bare key
 * for owned cargo.
 */
async function pump(chatId: string): Promise<void> {
	const owner = state().queues.get(key(chatId))?.[0]?.owner;
	if (owner === undefined) return await pumpInner(chatId);
	return await runAsOwner(owner, () => pumpInner(chatId));
}

async function pumpInner(chatId: string): Promise<void> {
	if (!chatId) return;
	const s = state();
	if (s.pumping.has(key(chatId))) return;
	s.pumping.add(key(chatId));
	let parked = false;
	try {
		for (let attempt = 0; ; ) {
			const queue = s.queues.get(key(chatId));
			if (!queue || queue.length === 0) {
				s.queues.delete(key(chatId));
				return;
			}

			// Gone chat: nothing to deliver into.
			const record = await stores.chatStore.getChat(chatId);
			if (!record) {
				s.queues.delete(key(chatId));
				for (const entry of queue) {
					entry.reject(new Error(`chat ${chatId} not found — cannot deliver steer ${entry.steer.id}`));
				}
				continue;
			}

			// Idempotent delivery: the transcript already carries these steers
			// (an in-run injection persisted, a wake completed, or a duplicate
			// deliver raced in). Resolve and flip without re-firing anything.
			noteSteersDurable(chatId, record.messages);
			const stillPending = (s.queues.get(key(chatId)) ?? []).filter((entry) => !entry.waking && !entry.deferred);
			if (stillPending.length === 0) { parked = true; return; }
			if (!(await automaticFollowUpAllowedAsync(chatId, s.liveAgents.get(key(chatId))))) { parked = true; return; }

			// VEHICLE 1 — THE LIVE RUN: pi's steering queue. The agent of the
			// streaming turn takes every eligible marker; pi injects at the
			// next turn boundary (message_start/message_end on the live wire,
			// between completed assistant+toolResult units) and continues the
			// run. Delivery resolves at settlement (settleSteers). Nothing else
			// to do in this loop iteration — the turn owns the delivery.
			const live = s.liveAgents.get(key(chatId));
			if (live && isTurnRunning(chatId)) {
				handOffEligible(chatId, live);
				const handable = stillPending.filter((e) => e.handedTo === live);
				// probe-handoffs never ride a live run (owner ruling: the
				// handoff must START the teacher's run) — if any remain
				// pending, wait the run out and loop to the wake below.
				const handoffWaits = stillPending.some(
					(e) => e.steer.customType === "probe-handoff",
				);
				if (handable.length > 0 && !handoffWaits) {
					return; // the run delivers; settleSteers re-pumps the rest
				}
				if (handable.length > 0) {
					await delay(POLL_MS);
					await waitForIdle(chatId);
					continue;
				}
			}

			// VEHICLE 2 — THE IDLE WAKE: one server-side turn carrying EVERY
			// pending marker as its input appends (the handler write-ahead
			// persists them under the wake's own turn claim).
			await waitForIdle(chatId);

			// Re-fetch AFTER the gates open — waitForIdle can wait out a quiz
			// answer (minutes), and sending the pre-wait snapshot would clobber
			// the client's answer + continuation in the write-ahead persist.
			const fresh = await stores.chatStore.getChat(chatId);
			if (!fresh) {
				continue; // the gone-chat branch rejects next iteration
			}

			// The runner is required — chat-handler sets it at init. If some
			// module instance missed the wiring, fail loudly rather than hang.
			if (!s.turnRunner) {
				const err = new Error("wake pipeline: no turn runner wired (setTurnRunner)");
				for (const entry of stillPending) deferOrReject(chatId, entry, err);
				parked = true;
				return;
			}

			// A live run may have delivered some markers while the gates were
			// closed — re-check: only still-missing markers ride the wake.
			noteSteersDurable(chatId, fresh.messages);
			const fire = (s.queues.get(key(chatId)) ?? []).filter((entry) => !entry.waking && !entry.deferred && !entry.handedTo);
			if (fire.length === 0) return;

			// THE DISMISSAL PAUSE (owner design 2026-10-03, "A2"): the record
			// ends in a user dismissal — the session waits for the USER. Hold
			// every marker in the queue (no wake fires) and return; the user's
			// next send is the wake that carries them (the in-run vehicle below
			// hands them to that turn once the text-claim lands — until then,
			// settlement re-pumps and lands them right after it). The pause is
			// derived from the tail, so any user message un-holds by construction.
			// An interrupted question-recovery request also waits for explicit
			// input; a queued job must not restart its replacement turn.
			if (endsInDismissal(fresh.messages) || endsInQuestionRecovery(fresh.messages) || !(await automaticFollowUpAllowedAsync(chatId))) {
				parked = true;
				return;
			}

			// Keep ownership through the wake. The flag excludes cargo from
			// its own live-agent handoff while duplicate callers share it.
			for (const entry of fire) entry.waking = true;
			const steers = fire.map((e) => e.steer);

			// Fire the wake with cargo still registered. A 409 releases its
			// vehicle flag and retries after the existing backoff, without
			// appending another registry entry.
			const status = await s.turnRunner(chatId, { type: "steers", steers }).catch((err: unknown) => {
				console.error(`[steer ${steers.map((x) => x.id).join(",")}] wake turn crashed:`, err);
				return -1;
			});
			const saved = await stores.chatStore.getChat(chatId);
			if (saved) noteSteersDurable(chatId, saved.messages);
			const owned = fire.filter((entry) => s.queues.get(key(chatId))?.includes(entry));
			if (status === 403 || status === 409) {
				for (const entry of owned) { entry.waking = false; entry.wakeAgent = undefined; }
				if (status === 403) { parked = true; return; }
				await delay(RETRY_BACKOFF_MS[Math.min(attempt++, RETRY_BACKOFF_MS.length - 1)]!);
				continue;
			}
			attempt = 0;
			for (const entry of owned) {
				if (status === 200 && !jobIdOf(entry.steer)) {
					// Preserve the non-job probe handoff's acceptance semantics.
					completeEntry(chatId, entry);
				} else if (status !== 200 || !isTurnRunning(chatId)) {
					deferOrReject(chatId, entry, new Error(`wake turn did not persist steer (status ${status})`));
				}
				// An accepted live turn still owns its cargo until canonical save
				// or settlement. HTTP 200 alone is not a durable marker receipt.
			}
		}
	} finally {
		s.pumping.delete(key(chatId));
		// A steer may have arrived between the last check and the finally —
		// restart the pump rather than strand it. Entries already handed to
		// a live run are NOT stragglers (settleSteers owns their resurrection)
		// — restarting for them would just park in waitForIdle forever.
		const q = state().queues.get(key(chatId)) ?? [];
		if (!parked && (await automaticFollowUpAllowedAsync(chatId, state().liveAgents.get(key(chatId)))) && q.some((e) => e.handedTo === undefined && !e.waking && !e.deferred)) void pump(chatId);
	}
}

// Connection changes are the only wake for consent-deferred automatic work.
// No retry timer, inference, or API-key fallback is started while consent is off.
state().stopConnectionWatch?.();
state().stopConnectionWatch = onSubscriptionChange(() => {
	const s = state();
	for (const [chatId, agent] of s.liveAgents) {
		if (!isSubscriptionProvider(agent.state?.model?.provider) || automaticFollowUpAllowed(chatId, agent)) continue;
		const consumed = new Set(agent.state.messages.map((m) => (m as { id?: string }).id));
		const pending = (s.queues.get(key(chatId)) ?? []).filter((entry) => entry.handedTo === agent && !consumed.has(entry.steer.id));
		if (pending.length === 0) continue;
		agent.clearSteeringQueue();
		for (const entry of pending) entry.handedTo = undefined;
		for (const entry of s.userSteers.get(key(chatId)) ?? []) if (!consumed.has(entry.message.id)) entry.handedTo = undefined;
		handOffEligible(chatId, agent); // only unconsumed learner input; never replay consumed steers
	}
	// Keys are `owner:chatId`; the entry carries the raw id back for pump().
	for (const [composite, entries] of s.queues) {
		const raw = entries[0]?.chatId;
		if (raw !== undefined) void automaticFollowUpAllowedAsync(raw, s.liveAgents.get(composite)).then((allowed) => {
		if (allowed) void pump(raw);
	}, () => { /* an unresolvable chat stays parked until its next wake */ });
	}
});

function deferOrReject(chatId: string, entry: QueuedSteer, error: Error): void {
	entry.waking = false;
	entry.wakeAgent = undefined;
	if (jobIdOf(entry.steer)) {
		entry.deferred = true;
		console.error(`[steer ${entry.steer.id}] delivery remains pending:`, error.message);
	} else {
		removeEntry(chatId, entry);
		entry.reject(error);
	}
}

/** Acknowledge session delivery without changing the worker outcome.
 *  Synchronous under a sync adapter (the registry's bookkeeping contract);
 *  an async adapter is followed without ever throwing into the hook. */
function finalizeJob(jobId: string): void {
	const fail = (error: unknown) => {
		// The conversation is already durable. A bookkeeping failure must
		// never replay that marker or turn a successful worker into a failure.
		console.error(`[job ${jobId}] delivery acknowledgement failed:`, error);
	};
	const fromRecord = (job: JobRecord | null): void => {
		if (!job) return;
		onReady(job.delivery ? job : normalizeLegacyResult(job), (resolved) => {
			if (resolved.delivery?.status !== "pending") return;
			const written = stores.jobStore.updateJob(jobId, { delivery: { ...resolved.delivery, status: "delivered" } });
			if (isPromiseLike(written)) void written.catch(fail);
		}, fail);
	};
	onReady(stores.jobStore.getJob(jobId), fromRecord, fail);
}

function normalizeLegacyResult(job: JobRecord): MaybePromise<JobRecord> {
	if (job.delivery || job.status !== "running" || !job.result) return job;
	const failed = isSubagentFailure(job.kind, job.result as never);
	const written = stores.jobStore.updateJob(job.id, {
		status: failed ? "error" : "done", activity: failed ? "failed" : "finished",
		delivery: { kind: "result", status: "pending" },
	});
	return isPromiseLike(written) ? written.then((updated) => updated ?? job) : written ?? job;
}

/** Restore known obligations only; old terminal records are never replayed. */
function restorePendingDeliveries(chatId: string): void {
	const fail = (error: unknown) => {
		console.error(`[chat ${chatId}] pending delivery restore failed:`, error);
	};
	const withRecord = (record: ChatRecord | null): void => {
		if (!record) return;
		noteSteersDurable(chatId, record.messages);
		onReady(stores.jobStore.listJobs(chatId), (jobs) => {
			for (const stored of jobs) {
				const live = isJobLive(stored.id);
				// Plugin result preparation persists an honest generic fallback before
				// awaiting the author formatter. Do not deliver that fallback early
				// while the live formatter still owns preparation; a restart has no
				// registration and can restore it without replaying author code.
				if (stored.kind === "plugin" && live && !(state().queues.get(key(chatId)) ?? []).some((entry) => jobIdOf(entry.steer) === stored.id)) continue;
				const finish = (job: JobRecord): void => {
					if (job.delivery?.status !== "pending") return;
					const steer = job.delivery.kind === "abort" ? buildAbortSteer(job)
						: job.delivery.kind === "failure" ? buildJobFailureSteer(job, job.error ?? "Background job recovery or delivery failed")
						: job.result ? buildSubagentSteer(job, job.result as never) : undefined;
					if (!steer) return;
					if (steerDelivered(record.messages, steer.id)) finalizeSteer(steer);
					else queueSteer(chatId, steer);
				};
				if (live) finish(stored);
				else onReady(normalizeLegacyResult(stored), finish, fail);
			}
		}, fail);
	};
	onReady(stores.chatStore.getChat(chatId), withRecord, fail);
}

/**
 * Wait until the chat can take a wake turn: no turn in flight AND no
 * unanswered question call (the record's dangling question — the answer
 * arrives as its tool result, and no turn may run in the window). Poll;
 * the learner may take arbitrarily long to answer, and that is correct —
 * the steer fires right after their answer turn completes.
 */
async function waitForIdle(chatId: string): Promise<void> {
	for (;;) {
		const record = await stores.chatStore.getChat(chatId);
		if (!record || !(state().queues.get(key(chatId)) ?? []).some((entry) => !entry.waking && !entry.deferred && !entry.handedTo)) return;
		const blocked = isTurnRunning(chatId) || hasUnresolvedQuestion(record.messages);
		if (!blocked) {
			await delay(GRACE_MS);
			const recheck = await stores.chatStore.getChat(chatId);
			if (
				!isTurnRunning(chatId) &&
				recheck &&
				!hasUnresolvedQuestion(recheck.messages)
			) {
				return;
			}
		}
		await delay(POLL_MS);
	}
}

// ─── crash recovery ──────────────────────────────────────────────────────────

const SWEEP_THROTTLE_MS = 30_000;

/**
 * Lazy sweep (called off the /api/jobs poll, throttled), LIVENESS-GATED
 * (accuracy wave, 2026-09-19): a "running" record without a live loop
 * registration (subagents/aborts.ts) is an orphan of a process death —
 * re-deliver its stored result (idempotently) or re-spawn the loop, at
 * once (the old 15-minute age heuristic waited on ghosts AND re-ran
 * hung-but-alive loops beside themselves — the figure-maker incident,
 * 2026-09-18). A record WITH a live registration is provably executing
 * in THIS process — never touched, however old: a hung first model call
 * stays honestly running until END kills it. Terminal workers with known
 * pending delivery are restored independently; old terminal records without
 * delivery metadata are never inferred to owe a delivery.
 */
/** Re-run a job's sub-agent loop — exposed for the sweep's tests (the
 *  /api/jobs poll is its only production caller, disabled under NODE_ENV=test). */
export async function recoverStaleJobs(): Promise<void> {
	const s = state();
	const now = Date.now();
	// TENANCY: the sweep only sees the ACTIVE owner's chats, so the throttle
	// is per owner — a global one would starve every other learner.
	const owner = currentOwnerId() ?? "";
	// Tolerate a legacy numeric value: fixtures reset the throttle by assigning
	// 0, and a shape change must not break them.
	const last = typeof s.lastSweepAt === "number" ? s.lastSweepAt : (s.lastSweepAt.get(owner) ?? 0);
	if (now - last < SWEEP_THROTTLE_MS) return;
	if (typeof s.lastSweepAt === "number") s.lastSweepAt = new Map();
	s.lastSweepAt.set(owner, now);
	try {
		for (const chat of await stores.chatStore.listChats()) {
			for (const job of await stores.jobStore.listJobs(chat.id)) {
				if (isJobLive(job.id)) continue; // never re-run beside live computation
				if (!(await stores.chatStore.getChat(job.chatId))) continue;
				if (isTurnRunning(job.chatId)) continue;
				const recovered = await normalizeLegacyResult(job);
				if (recovered.delivery?.status === "pending") {
					restorePendingDeliveries(job.chatId);
					void pump(job.chatId);
				} else if (job.status === "running" && !job.result) {
					if (job.kind === "plugin") {
						// Canonical task reads only; never respawn plugin tools/code.
						if (s.recoverPlugin) void s.recoverPlugin(job).catch(async (error: unknown) => {
							if ((await stores.jobStore.getJob(job.id))?.status !== "running") return;
							const failure = `Plugin job recovery failed: ${String(error)}`;
							await stores.jobStore.updateJob(job.id, { status: "error", error: failure, activity: "recovery failed", delivery: { kind: "failure", status: "pending" } });
							void deliverJobResult(buildJobFailureSteer(job, failure));
						});
						continue;
					}
					// The sub-agent loop itself died with the process: re-spawn.
					if (!s.respawn) continue;
					await stores.jobStore.updateJob(job.id, { activity: "recovering: re-running" });
					s.respawn(job.id);
				}
			}
		}
	} catch (err) {
		console.error("[jobs] stale-job recovery sweep failed:", err);
	}
}

/** The /api/jobs entry: job list for the client poll (+ lazy recovery). */
export async function listJobs(chatId: string): Promise<JobRecord[]> {
	if (process.env.NODE_ENV !== "test") await recoverStaleJobs();
	return await stores.jobStore.listJobs(chatId);
}
