/**
 * MULTI-TENANT SECURITY PIN (PR 2 of the stack): four independent leaks must
 * stay closed —
 *   1. the SSE bus must never feed one tenant's frames to another window;
 *   2. operator capabilities must come from the Proxy's verified header, never
 *      from a client-supplied one;
 *   3. hosted learners must not receive host-filesystem tools;
 *   4. plugin-worker activity rows and aborts must be tenant-scoped.
 *
 * Every project import is dynamic: config.ts resolves LH_DATA_DIR at module
 * load, and the host barrels pull it in transitively.
 */
import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach, mock } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ServerEvent } from "../src/core/events.ts";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-multitenant-security-"));
process.env.LH_DATA_DIR = dataDir;
process.env.LH_AUTH_FILE = path.join(dataDir, "auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}");

const { emit, subscribe } = await import("../src/core/events.ts");
const { runAsOwner, currentOwnerId } = await import("../src/core/owner-scope.ts");
const {
	OPERATOR_HEADER, OWNER_HEADER, isOperatorRequest, operatorRefusal, operatorOnly,
} = await import("../src/server/request-owner.ts");
const { createProberTools, createTeacherTools } = await import("../src/agent/tools.ts");
const { eventsResponse } = await import("../src/server/events-stream.ts");
const {
	registerPluginWorkerActivity, pluginWorkerActivities, abortPluginWorkerActivity,
} = await import("../src/server/plugin-worker-activity.ts");
const { createPluginWorkerService } = await import("../src/agent/plugin-workers.ts");
const { createPluginTaskRecordStore } = await import("../src/store/plugin-task-records.ts");

const A = "9d0409ac-ee31-4944-8cc8-56ef5eb1bed5";
const B = "0f0e0d0c-0b0a-4908-8706-050403020100";
const LEARNER = "learner@example.test";
const OPERATOR = "op@example.test";
const origin = "http://localhost";
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

const ENV_KEYS = [
	"HOSTED_MODE", "ADMIN_EMAIL", "NEXT_PUBLIC_SUPABASE_URL",
	"NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "SUPABASE_DB_URL", "HOSTED_PILOT_EMAIL",
] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

beforeEach(() => {
	for (const key of ENV_KEYS) delete process.env[key];
	fs.rmSync(path.join(dataDir, "admissions.json"), { force: true });
});
afterEach(() => {
	mock.restoreAll();
	for (const key of ENV_KEYS) {
		const value = savedEnv[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

function hostedEnv(): void {
	Object.assign(process.env, {
		HOSTED_MODE: "on",
		NEXT_PUBLIC_SUPABASE_URL: "https://supabase.invalid",
		NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
		SUPABASE_DB_URL: "postgresql://unused",
	});
}

function request(headers: Record<string, string> = {}): Request {
	return new Request("http://localhost/api/x", { headers });
}

function operatorRequest(owner?: string): Request {
	return request({
		...(owner === undefined ? {} : { [OWNER_HEADER]: owner }),
		[OPERATOR_HEADER]: "1",
	});
}

// ─── 1. owner-scoped SSE bus ──────────────────────────────────────────────────

describe("owner-scoped SSE event bus", () => {
	it("owner A never receives owner B's turn-started / chats-changed / plugin-message", () => {
		const gotA: string[] = [];
		const gotB: string[] = [];
		const offA = subscribe((event: ServerEvent) => gotA.push(event.type), { owner: A });
		const offB = subscribe((event: ServerEvent) => gotB.push(event.type), { owner: B });
		try {
			runAsOwner(B, () => emit("turn-started", { chatId: "b1" }));
			runAsOwner(B, () => emit("chats-changed", {}));
			runAsOwner(B, () => emit("plugin-message", { pluginId: "p", topic: "t", data: { secret: "b" } }));
			assert.deepEqual(gotA, [], "no cross-tenant frames, no tenant payloads");
			assert.deepEqual(gotB, ["turn-started", "chats-changed", "plugin-message"]);

			runAsOwner(A, () => emit("turn-started", { chatId: "a1" }));
			assert.deepEqual(gotA, ["turn-started"]);
		} finally {
			offA();
			offB();
		}
	});

	it("an unscoped plugins-changed reaches a scoped subscriber — other unscoped events do not", () => {
		const gotA: string[] = [];
		const offA = subscribe((event: ServerEvent) => gotA.push(event.type), { owner: A });
		try {
			emit("chats-changed", {});
			emit("turn-started", { chatId: "ambient" });
			assert.deepEqual(gotA, [], "unscoped TENANT events stay out");
			emit("plugins-changed", {});
			assert.deepEqual(gotA, ["plugins-changed"], "plugin availability is safe and global");
		} finally {
			offA();
		}
	});

	it("an unscoped subscriber still receives every event from every scope", () => {
		const got: string[] = [];
		const off = subscribe((event: ServerEvent) => got.push(event.type));
		try {
			runAsOwner(A, () => emit("turn-started", { chatId: "a" }));
			runAsOwner(B, () => emit("chats-changed", {}));
			emit("activity-changed", {});
			assert.deepEqual(got, ["turn-started", "chats-changed", "activity-changed"]);
		} finally {
			off();
		}
	});

	it("the SSE seam binds the connection to its owner at construction", async () => {
		const decode = (chunk: Uint8Array) => new TextDecoder().decode(chunk);
		const timeout = () => new Promise<string>((resolve) => {
			const timer = setTimeout(() => resolve("timeout"), 25);
			timer.unref?.();
		});

		// Negative: a connection opened for A sees nothing when B emits.
		const other = runAsOwner(A, () => eventsResponse());
		const otherReader = other.body!.getReader();
		try {
			runAsOwner(B, () => emit("chats-changed", {}));
			const result = await Promise.race([otherReader.read().then(() => "frame"), timeout()]);
			assert.equal(result, "timeout", "no foreign tenant frame on A's SSE connection");
		} finally {
			await otherReader.cancel();
		}

		// Positive: the same construction DOES receive its own owner's event.
		const own = runAsOwner(A, () => eventsResponse());
		const ownReader = own.body!.getReader();
		try {
			runAsOwner(A, () => emit("chats-changed", {}));
			const { value } = await ownReader.read();
			assert.match(decode(value!), /event: chats-changed/);
		} finally {
			await ownReader.cancel();
		}
	});
});

// ─── 2. operator capability header ───────────────────────────────────────────

describe("Proxy operator header", () => {
	function sessionCookie(email: string, id = A): string {
		const session = {
			access_token: "t", refresh_token: "t", expires_at: Math.floor(Date.now() / 1000) + 3600,
			user: { id, email },
		};
		return `sb-supabase-auth-token=base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`;
	}
	function mockGoTrue(email: string, id = A) {
		return mock.method(globalThis, "fetch", async () => Response.json({ id, email }));
	}
	function writeAdmissions(emails: string[]) {
		fs.writeFileSync(path.join(dataDir, "admissions.json"), JSON.stringify({ version: 1, emails }));
	}

	it("strips a client-supplied x-lh-operator: 1 from a learner's request", async () => {
		hostedEnv();
		process.env.ADMIN_EMAIL = OPERATOR;
		writeAdmissions([LEARNER, OPERATOR]);
		mockGoTrue(LEARNER);
		const { proxy } = await import("../proxy.ts");
		const { NextRequest } = await import("next/server");
		const response = await proxy(new NextRequest(new URL("/api/keys", origin), {
			headers: { cookie: sessionCookie(LEARNER), [OPERATOR_HEADER]: "1" },
		}));
		assert.equal(response.status, 200);
		const overrides = (response.headers.get("x-middleware-override-headers") ?? "")
			.split(",").map((name) => name.trim());
		assert.equal(overrides.includes(OPERATOR_HEADER), false, "spoofed header is dropped from overrides");
		assert.equal(response.headers.get(`x-middleware-request-${OPERATOR_HEADER}`), null);
		assert.equal(response.headers.get(`x-middleware-request-${OWNER_HEADER}`), A);
	});

	it("sets x-lh-operator: 1 only for the configured ADMIN_EMAIL", async () => {
		hostedEnv();
		process.env.ADMIN_EMAIL = OPERATOR;
		writeAdmissions([OPERATOR]);
		mockGoTrue(OPERATOR);
		const { proxy } = await import("../proxy.ts");
		const { NextRequest } = await import("next/server");
		const response = await proxy(new NextRequest(new URL("/api/keys", origin), {
			headers: { cookie: sessionCookie(OPERATOR) },
		}));
		assert.equal(response.status, 200);
		assert.equal(response.headers.get(`x-middleware-request-${OPERATOR_HEADER}`), "1");
		assert.equal(response.headers.get(`x-middleware-request-${OWNER_HEADER}`), A);
	});
});

describe("operatorOnly / operatorRefusal", () => {
	it("refuses non-operators in hosted mode with a cache-controlled 403", async () => {
		hostedEnv();
		const refusal = operatorRefusal(request());
		assert.equal(refusal?.status, 403);
		assert.deepEqual(await refusal!.json(), { error: "Operator access required." });
		assert.equal(refusal!.headers.get("Cache-Control"), "no-store");
		assert.equal(isOperatorRequest(request()), false);
		assert.equal(isOperatorRequest(operatorRequest()), true);
	});

	it("allows operators through, still inside their owner scope", () => {
		hostedEnv();
		const handler = operatorOnly((_req: Request) => currentOwnerId());
		assert.equal(handler(operatorRequest(A)), A, "operatorOnly preserves ownerScoped");
		assert.equal(currentOwnerId(), undefined);
		const refusal = handler(request());
		assert.ok(refusal instanceof Response);
		assert.equal(refusal.status, 403);
	});

	it("passes every request through when HOSTED_MODE is off", () => {
		delete process.env.HOSTED_MODE;
		const handler = operatorOnly((_req: Request) => "ran");
		assert.equal(isOperatorRequest(request()), true);
		assert.equal(operatorRefusal(request()), undefined);
		assert.equal(handler(request()), "ran");
		assert.equal(handler(operatorRequest()), "ran");
	});
});

describe("GET /api/keys", () => {
	it("returns empty keys/providers to a hosted non-operator and the real list to an operator", async () => {
		hostedEnv();
		const { GET } = await import("../app/api/keys/route.ts");
		const learner = await GET(request());
		assert.equal(learner.status, 200);
		assert.equal(learner.headers.get("Cache-Control"), "no-store");
		assert.deepEqual(await learner.json(), { keys: [], providers: [] });

		const operator = await GET(operatorRequest(A));
		assert.equal(operator.status, 200);
		const body = (await operator.json()) as { keys: unknown[]; providers: unknown[] };
		assert.ok(Array.isArray(body.keys) && Array.isArray(body.providers));
		assert.ok(body.providers.length > 0, "operators see the real provider catalog");

		delete process.env.HOSTED_MODE;
		const desktop = await GET(request());
		const desktopBody = (await desktop.json()) as { providers: unknown[] };
		assert.ok(desktopBody.providers.length > 0, "desktop behavior is unchanged");
	});
});

// ─── 3. host filesystem tools ────────────────────────────────────────────────

describe("host filesystem tools in hosted mode", () => {
	const FS_TOOLS = ["read", "ls", "find", "grep"];
	const proberCtx = {
		chatId: "c", chatStore: {} as never, jobStore: {} as never,
		deliver: () => {}, spawn: () => {},
	};
	const teacherCtx = { chatId: "c", chatStore: {} as never, jobStore: {} as never, spawn: () => {} };

	it("omits read/ls/find/grep from the prober when hosted, keeps them otherwise", () => {
		process.env.HOSTED_MODE = "on";
		const hosted = Object.keys(createProberTools(proberCtx));
		for (const name of FS_TOOLS) assert.equal(hosted.includes(name), false, `${name} absent when hosted`);
		assert.ok(hosted.includes("probe_done") && hosted.includes("ask_user_question"));

		delete process.env.HOSTED_MODE;
		const desktop = Object.keys(createProberTools(proberCtx));
		for (const name of FS_TOOLS) assert.ok(desktop.includes(name), `${name} present on desktop`);
	});

	it("omits read/ls/find/grep/show_image from the teacher when hosted, keeps them otherwise", () => {
		process.env.HOSTED_MODE = "on";
		const hosted = Object.keys(createTeacherTools(teacherCtx));
		for (const name of [...FS_TOOLS, "show_image"]) {
			assert.equal(hosted.includes(name), false, `${name} absent when hosted`);
		}
		assert.ok(hosted.includes("plan_init") && hosted.includes("quiz"));

		delete process.env.HOSTED_MODE;
		const desktop = Object.keys(createTeacherTools(teacherCtx));
		for (const name of [...FS_TOOLS, "show_image"]) {
			assert.ok(desktop.includes(name), `${name} present on desktop`);
		}
	});
});

// ─── 4. plugin worker activity ───────────────────────────────────────────────

describe("owner-scoped plugin worker activity", () => {
	const metadata = (owner: string | undefined, taskId: string) => ({
		id: taskId,
		definitionId: "worker",
		status: "queued" as const,
		model: { provider: "offline-fixture", id: "held" },
		createdAt: "2026-11-22T00:00:00.000Z",
		updatedAt: "2026-11-22T00:00:00.000Z",
		...(owner === undefined ? {} : { owner }),
	});

	it("filters activity rows by the reading owner and refuses cross-tenant aborts", () => {
		const activation = new AbortController();
		const cancelled: string[] = [];
		const changed = registerPluginWorkerActivity({
			pluginId: "tenant-plugin", pluginName: "Tenant", signal: activation.signal,
			cancel: (id) => { cancelled.push(id); },
		});
		try {
			changed(metadata(A, "task-a"));
			changed(metadata(B, "task-b"));
			assert.deepEqual(pluginWorkerActivities().map((row) => row.taskId).sort(), ["task-a", "task-b"]);
			assert.deepEqual(runAsOwner(A, () => pluginWorkerActivities().map((row) => row.taskId)), ["task-a"]);
			assert.deepEqual(runAsOwner(B, () => pluginWorkerActivities().map((row) => row.taskId)), ["task-b"]);

			assert.equal(runAsOwner(B, () => abortPluginWorkerActivity("tenant-plugin:task-a")), false);
			assert.deepEqual(cancelled, [], "B cannot cancel A's worker even knowing the id");
			assert.equal(runAsOwner(A, () => abortPluginWorkerActivity("tenant-plugin:task-a")), true);
			assert.deepEqual(cancelled, ["task-a"]);
		} finally {
			activation.abort();
		}
	});

	it("stamps the accepting owner onto live worker metadata", async (t) => {
		const { Type } = await import("typebox");
		const store = createPluginTaskRecordStore(path.join(dataDir, "worker-tasks"));
		const activation = new AbortController();
		const changes: { owner?: string }[] = [];
		const service = createPluginWorkerService({
			store, signal: activation.signal,
			engineFor: () => new Promise(() => {}),
			onChange: (value) => { changes.push(value); },
		});
		t.after(async () => { activation.abort(); await service.dispose(); });
		service.register({ id: "worker", instructions: "private", resultSchema: Type.String() });
		runAsOwner(A, () => service.start("worker", {
			requestId: "request", input: null, prompt: "private prompt",
			model: { provider: "offline-fixture", id: "held" }, purpose: "user", maxTurns: 1,
		}));
		await tick();
		assert.ok(changes.length > 0);
		assert.equal(changes[0]?.owner, A, "the metadata carries the owner for activity filtering");
	});
});
