import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// config.ts resolves LH_DATA_DIR at MODULE LOAD, so the root must exist and be
// set before anything imports it. One root for the whole file; per-test
// subdirectories keep the cases independent.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-tenancy-"));
process.env.LH_DATA_DIR = dataDir;

const { currentOwnerId, runAsOwner, requireOwnerId } = await import("../src/core/owner-scope.ts");
const { ownerPaths, dataRoot, baseDataRoot } = await import("../config.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { settingsStore } = await import("../src/store/settings.ts");
const { jobStore } = await import("../src/store/jobs.ts");
const { graphStore } = await import("../src/store/graph.ts");
const { themeStore } = await import("../src/store/themes.ts");
const { withOwner, forOwner, activeOwner, stores: appStores } = await import("../src/server/stores.ts");
const { THEME_COLOR_KEYS } = await import("../src/core/themes.ts");
const { expectSync } = await import("../src/core/ports.ts");

const A = "9d0409ac-ee31-4944-8cc8-56ef5eb1bed5";
const B = "0f0e0d0c-0b0a-4908-8706-050403020100";

beforeEach(() => {
	// Fresh hosted/ tree per case; the root itself stays (it is module state).
	fs.rmSync(path.join(dataDir, "hosted"), { recursive: true, force: true });
	fs.rmSync(path.join(dataDir, "chats"), { recursive: true, force: true });
});

afterEach(() => {
	fs.rmSync(path.join(dataDir, "hosted"), { recursive: true, force: true });
});

describe("owner scope", () => {
	it("is empty outside a scope and canonical inside one", () => {
		assert.equal(currentOwnerId(), undefined);
		runAsOwner(A.toUpperCase(), () => assert.equal(currentOwnerId(), A));
		assert.equal(currentOwnerId(), undefined, "scope does not leak out");
	});

	it("refuses a non-UUID owner", () => {
		assert.throws(() => runAsOwner("../../etc", () => undefined), /Invalid owner id/);
	});

	it("requireOwnerId throws outside a scope", () => {
		assert.throws(() => requireOwnerId(), /No owner scope/);
	});

	it("nests and restores the outer owner", () => {
		runAsOwner(A, () => {
			runAsOwner(B, () => assert.equal(currentOwnerId(), B));
			assert.equal(currentOwnerId(), A);
		});
	});
});

describe("owner paths", () => {
	it("roots mutable records under hosted/<owner> and leaves app assets alone", () => {
		runAsOwner(A, () => {
			const paths = ownerPaths();
			assert.equal(paths.data, path.join(baseDataRoot(), "hosted", A));
			assert.equal(paths.chats, path.join(baseDataRoot(), "hosted", A, "chats"));
			assert.equal(paths.settings, path.join(baseDataRoot(), "hosted", A, "settings.json"));
			assert.equal(dataRoot(), path.join(baseDataRoot(), "hosted", A));
		});
	});

	it("falls back to the legacy root when unscoped", () => {
		assert.equal(dataRoot(), baseDataRoot());
		assert.equal(ownerPaths().chats, path.join(baseDataRoot(), "chats"));
	});

	it("keeps two owners on disjoint roots", () => {
		const a = runAsOwner(A, () => dataRoot());
		const b = runAsOwner(B, () => dataRoot());
		assert.notEqual(a, b);
	});
});

describe("store isolation", () => {
	it("chats, settings, jobs, graph and themes do not cross owners", () => {
		const chatA = runAsOwner(A, () => expectSync(chatStore.createChat("A session"), "createChat"));
		const chatB = runAsOwner(B, () => expectSync(chatStore.createChat("B session"), "createChat"));

		assert.deepEqual(runAsOwner(A, () => expectSync(chatStore.listChats(), "listChats").map((c) => c.id)), [chatA.id]);
		assert.deepEqual(runAsOwner(B, () => expectSync(chatStore.listChats(), "listChats").map((c) => c.id)), [chatB.id]);

		// A's chat id must not resolve for B.
		assert.equal(runAsOwner(B, () => expectSync(chatStore.getChat(chatA.id), "getChat")), null);
		assert.notEqual(runAsOwner(A, () => expectSync(chatStore.getChat(chatA.id), "getChat")), null);

		runAsOwner(A, () => settingsStore.writeSettings({ version: 1, general: { autoUpdate: false } }));
		assert.equal(runAsOwner(B, () => settingsStore.readSettings()), null, "B has no settings record yet");
		assert.equal(runAsOwner(A, () => expectSync(settingsStore.readSettings(), "readSettings")?.general?.autoUpdate), false);

		runAsOwner(A, () => jobStore.createJob({ chatId: chatA.id, kind: "research", input: { query: "x" } } as never));
		assert.equal(runAsOwner(A, () => expectSync(jobStore.listJobs(chatA.id), "listJobs").length), 1);
		assert.deepEqual(runAsOwner(B, () => expectSync(jobStore.listJobs(chatA.id), "listJobs")), []);

		runAsOwner(A, () => graphStore.appendNode({
			id: "n1", name: "n", statement: "s", aliases: [],
			createdAt: new Date().toISOString(), provenance: [],
		}));
		assert.equal(runAsOwner(A, () => expectSync(graphStore.readNodes(), "readNodes").length), 1);
		assert.equal(runAsOwner(B, () => expectSync(graphStore.readNodes(), "readNodes").length), 0);

		runAsOwner(A, () => themeStore.writeTheme("mine", {
			name: "Mine", mode: "dark",
			colors: Object.fromEntries(THEME_COLOR_KEYS.map((key) => [key, "#123456"])) as Record<(typeof THEME_COLOR_KEYS)[number], string>,
		}));
		assert.deepEqual(runAsOwner(B, () => expectSync(themeStore.listThemes(), "listThemes")), []);
		assert.equal(runAsOwner(A, () => expectSync(themeStore.listThemes(), "listThemes").length), 1);
	});

	it("writes land on disk under the owner, not the shared root", () => {
		runAsOwner(A, () => chatStore.createChat("only A"));
		assert.equal(fs.existsSync(path.join(dataDir, "hosted", A, "chats")), true);
		assert.equal(fs.existsSync(path.join(dataDir, "chats")), false, "shared root untouched");
	});
});

describe("composition helpers", () => {
	it("withOwner scopes the callback and leaves unscoped undefined alone", () => {
		assert.equal(withOwner(undefined, () => currentOwnerId()), undefined);
		assert.equal(withOwner(A, () => currentOwnerId()), A);
	});

	it("forOwner runs the callback inside the owner scope", () => {
		const seen = forOwner(B, (stores) => {
			assert.equal(activeOwner(), B);
			// The app's stores are live proxies (PR 5) that delegate to the
			// active adapter — the fs chat store when no database is wired.
			assert.equal(stores.chatStore, appStores.chatStore);
			assert.deepEqual(Reflect.ownKeys(stores.chatStore).sort(), Reflect.ownKeys(chatStore).sort());
			return currentOwnerId();
		});
		assert.equal(seen, B);
		assert.equal(activeOwner(), undefined, "the scope ends with the callback");
	});
});