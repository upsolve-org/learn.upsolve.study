import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// The plugin-data roots live in the owner's own data directory (tenancy), so
// every scholar must see their own plugin data — and ONLY theirs.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-plugin-data-owner-"));
process.env.LH_DATA_DIR = dataDir;

const { safePluginDataDirectory, ownerScopedDirectory } = await import("../src/store/plugin-data-paths.ts");
const { runAsOwner } = await import("../src/core/owner-scope.ts");
const { ownerPaths, baseDataRoot } = await import("../config.ts");

const A = "9d0409ac-ee31-4944-8cc8-56ef5eb1bed5";
const B = "0f0e0d0c-0b0a-4908-8706-050403020100";

const communityDirectory = path.join(dataDir, "plugins");
const core = { directory: path.join(dataDir, "core-plugin-data"), ids: ["flashcards"] };

beforeEach(() => { fs.mkdirSync(communityDirectory, { recursive: true }); });
afterEach(() => { fs.rmSync(communityDirectory, { recursive: true, force: true }); });

describe("ownerScopedDirectory", () => {
	it("sends each scholar to their own core plugin directory", () => {
		const a = runAsOwner(A, () => ownerScopedDirectory(communityDirectory, "flashcards", core));
		const b = runAsOwner(B, () => ownerScopedDirectory(communityDirectory, "flashcards", core));
		assert.equal(a, path.join(ownerPathsFor(A), "core-plugin-data", "flashcards"));
		assert.equal(b, path.join(ownerPathsFor(B), "core-plugin-data", "flashcards"));
		assert.notEqual(a, b);
	});

	it("keeps a community plugin's data segment under the owner", () => {
		const a = runAsOwner(A, () => ownerScopedDirectory(communityDirectory, "wordcount", core));
		assert.equal(a, path.join(ownerPathsFor(A), "plugins", "wordcount", "data"));
	});

	it("is exactly the activation directory when unscoped", () => {
		const unscoped = ownerScopedDirectory(communityDirectory, "flashcards", core);
		assert.equal(unscoped, safePluginDataDirectory(communityDirectory, "flashcards", core, true));
		assert.equal(unscoped, path.join(core.directory, "flashcards"));
	});

	it("creates the owner directory on demand", () => {
		const a = runAsOwner(A, () => ownerScopedDirectory(communityDirectory, "flashcards", core));
		assert.ok(fs.statSync(a).isDirectory());
	});

	it("follows the scope on every call, so a frozen variable goes stale", () => {
		const atActivation = ownerScopedDirectory(communityDirectory, "flashcards", core);
		assert.equal(atActivation, path.join(core.directory, "flashcards"));
		const during = runAsOwner(A, () => ownerScopedDirectory(communityDirectory, "flashcards", core));
		assert.equal(during, path.join(ownerPathsFor(A), "core-plugin-data", "flashcards"));
	});

	it("rejects a malformed plugin id", () => {
		assert.throws(() => runAsOwner(A, () => ownerScopedDirectory(communityDirectory, "../x", core)), /Invalid plugin id/);
	});
});

/** Same shape config.ts derives for an owner, computed here so the test does
 *  not depend on the ambient scope to predict it. */
function ownerPathsFor(owner: string): string {
	return runAsOwner(owner, () => ownerPaths().data);
}

assert.notEqual(baseDataRoot(), undefined);