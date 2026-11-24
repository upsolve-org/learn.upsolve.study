import assert from "node:assert/strict";
import { describe, it, beforeEach, after } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// THE LEAK (2026-11-21): one backend activation opened ONE store from
// ctx.dataDirectory, so every signed-in scholar shared one library — decks,
// cards, sources and review history. Each call must now use the CALLER's own
// directory, and worker runs must land back on the accepting scholar.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-flashcards-owner-"));
process.env.LH_DATA_DIR = dataDir;

const backend = await import("../core-plugins/flashcards/backend.cjs");
const { currentOwnerId, runAsOwner } = await import("../src/core/owner-scope.ts");
const { ownerPaths } = await import("../config.ts");

after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const A = "9d0409ac-ee31-4944-8cc8-56ef5eb1bed5";
const B = "0f0e0d0c-0b0a-4908-8706-050403020100";

const activationDirectory = path.join(dataDir, "core-plugin-data", "flashcards");
fs.mkdirSync(activationDirectory, { recursive: true });

interface Started { id: string; definitionId: string; requestId: string; owner?: string }

/** A host stand-in with the minimum flashcards needs: handles, a worker
 *  registry that (like the real one) awaits the accepting owner, a learning
 *  graph that is empty and per-owner paths. */
function context() {
	const handlers = new Map<string, (input?: unknown) => unknown>();
	const starts: Started[] = [];
	const cleanup: Array<() => void> = [];
	const tasks = new Map<string, Started & { status: string }>();
	const controller = new AbortController();
	return {
		ctx: {
			manifest: { id: "flashcards" },
			// Unique per activation: a sibling suite re-activates this backend
			// in the same process, so the shared module keeps several alive.
			dataDirectory: fs.mkdtempSync(path.join(dataDir, "activation-")),
			ownerDirectory: () => ownerPaths().corePluginData + path.sep + "flashcards",
			signal: controller.signal,
			cleanup: (fn: () => void) => cleanup.push(fn),
			handle: (name: string, fn: (input?: unknown) => unknown) => handlers.set(name, fn),
			events: { emit() {}, on() { return () => {}; } },
			learning: { graph: () => ({ propositions: [], chains: [] }) },
			inference: { catalog: async () => ({ models: [] }) },
			workers: {
				register: () => () => {},
				list: () => [...tasks.values()],
				get: (id: string) => tasks.get(id),
				cancel() {},
				subscribe: () => () => {},
				// The real service re-enters the ACCEPTING owner before running.
				start: (definitionId: string, input: Started) => {
					const owner = currentOwnerId();
					const task = { ...input, id: input.requestId, definitionId, status: "queued", owner };
					tasks.set(task.id, task);
					starts.push(task);
					void (owner ? runAsOwner(owner, async () => {}) : Promise.resolve());
					return task;
				},
				wait: async () => {},
			},
		} as any,
		handlers,
		cleanup,
	};
}

function call(handlers: Map<string, (input?: unknown) => unknown>, owner: string, name: string, input?: unknown) {
	// The handler is awaited OUTSIDE run(), so its own await resumptions run in
	// the parent context. The real route wrapper awaits inside the scope.
	return runAsOwner(owner, () => handlers.get(name)!(input)) as Promise<any>;
}

const state = (owner: string, handlers: Map<string, (input?: unknown) => unknown>) => call(handlers, owner, "get-state");

describe("flashcards per-owner library", () => {
	beforeEach(async () => {
		fs.rmSync(path.join(dataDir, "hosted"), { recursive: true, force: true });
		fs.rmSync(activationDirectory, { recursive: true, force: true });
		fs.mkdirSync(activationDirectory, { recursive: true });
	});

	it("keeps two scholars' decks entirely apart", async () => {
		const { ctx, handlers } = context();
		backend.activate(ctx);
		await call(handlers, A, "create-deck", { name: "A deck" });
		await call(handlers, B, "create-deck", { name: "B deck" });

		const a = await state(A, handlers);
		const b = await state(B, handlers);
		assert.deepEqual(a.decks.map((d: { name: string }) => d.name), ["A deck"]);
		assert.deepEqual(b.decks.map((d: { name: string }) => d.name), ["B deck"]);
	});

	it("writes each library under the scholar's own directory", async () => {
		const { ctx, handlers } = context();
		backend.activate(ctx);
		await call(handlers, A, "create-deck", { name: "A deck" });
		assert.ok(fs.existsSync(path.join(dataDir, "hosted", A, "core-plugin-data", "flashcards", "flashcards.json")));
		assert.ok(!fs.existsSync(path.join(activationDirectory, "flashcards.json")), "the shared root stays untouched");
	});

	it("does not let one scholar's deck id resolve for another", async () => {
		const { ctx, handlers } = context();
		backend.activate(ctx);
		await call(handlers, A, "create-deck", { name: "A deck" });
		await call(handlers, B, "create-deck", { name: "B deck" });
		const b = await state(B, handlers);
		const a = await state(A, handlers);
		assert.deepEqual(a.decks.map((d: { name: string }) => d.name), ["A deck"]);
		assert.deepEqual(b.decks.map((d: { name: string }) => d.name), ["B deck"]);
		await assert.rejects(async () => call(handlers, B, "delete-deck", { id: a.decks[0].id }), /Deck not found/);
	});

	it("keeps ratings apart, so one scholar's review does not move the other's card", async () => {
		const { ctx, handlers } = context();
		backend.activate(ctx);
		const created = await call(handlers, A, "create-deck", { name: "Shared name" });
		const deckId = created.decks[0].id;
		const card = await call(handlers, A, "create-card", { requestId: "a-1", deckId, name: "Card", question: "Q", answer: "A" });
		await call(handlers, B, "create-deck", { name: "Shared name" });
		assert.equal((await state(B, handlers)).propositions.length, 0);
		assert.equal(card.state.propositions.length, 1);
	});

	it("stamps the accepting owner on background workers", async () => {
		const workers = await import("../src/agent/plugin-workers.ts");
		const store = { save() {}, get: () => null, list: () => [], remove() {} } as any;
		const service = workers.createPluginWorkerService({ store, engineFor: () => ({}) as any });
		service.register({ id: "w", instructions: "", resultSchema: { type: "object" }, maxTurns: 1 } as any);
		const task = runAsOwner(A, () => service.start("w", { requestId: "r-1", input: {}, prompt: "p", model: { provider: "x", id: "y" }, purpose: "user", maxTurns: 1 }));
		assert.equal(task.owner, A);
		const unscoped = service.start("w", { requestId: "r-2", input: {}, prompt: "p", model: { provider: "x", id: "y" }, purpose: "user", maxTurns: 1 });
		assert.equal(unscoped.owner, undefined, "plain dev stays byte-for-byte");
	});

	it("falls back to the activation directory when unscoped", async () => {
		const { ctx, handlers } = context();
		ctx.ownerDirectory = () => activationDirectory;
		backend.activate(ctx);
		await handlers.get("create-deck")!({ name: "Desktop deck" });
		assert.ok(fs.existsSync(path.join(activationDirectory, "flashcards.json")));
	});
});