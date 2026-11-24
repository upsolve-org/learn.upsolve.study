import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// A FRESH data root with no settings.json, so the learner record cannot supply
// a custom provider on its own — only the hosted default can. config.ts resolves
// LH_DATA_DIR at module load, so every import below is dynamic.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-catalog-default-"));
process.env.LH_DATA_DIR = dataDir;

const { catalogProviders, modelCatalog } = await import("../src/server/model-catalog.ts");

const KEYS = ["HOSTED_MODE", "HOSTED_DEFAULT_BASE_URL", "HOSTED_DEFAULT_MODEL", "HOSTED_DEFAULT_API_KEY"] as const;
const saved: Record<string, string | undefined> = {};
const complete = {
	HOSTED_MODE: "on",
	HOSTED_DEFAULT_BASE_URL: "https://gateway.example/v1",
	HOSTED_DEFAULT_MODEL: "auto",
	HOSTED_DEFAULT_API_KEY: "sk-secret",
};

function env(values: Record<string, string | undefined>) {
	for (const key of KEYS) {
		const value = values[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

beforeEach(() => {
	for (const key of KEYS) saved[key] = process.env[key];
	fs.rmSync(path.join(dataDir, "settings.json"), { force: true });
});
afterEach(() => {
	for (const key of KEYS) {
		if (saved[key] === undefined) delete process.env[key];
		else process.env[key] = saved[key];
	}
});

// REGRESSION (found live 2026-11-16): slots resolved to the default, but the
// catalog offered no custom provider row and no models, so the client's
// zero-keys gate still fired and the setup dialog opened over a working app.
describe("the picker catalog carries the default", () => {
	it("offers the custom provider row with a present key", async () => {
		env(complete);
		const row = (await catalogProviders()).find((p) => p.id === "custom");
		assert.equal(row?.keyPresent, true, "the default must clear the zero-keys gate");
	});

	it("lists the default model so the pickers have something to offer", async () => {
		env(complete);
		const catalog = await modelCatalog();
		assert.deepEqual(catalog.models.map((m) => m.id), ["auto"]);
		assert.equal(catalog.slots.strong?.model?.provider, "custom");
	});

	it("offers no custom row when the default is off", async () => {
		env({});
		assert.equal((await catalogProviders()).some((p) => p.id === "custom"), false);
		assert.equal((await modelCatalog()).models.length, 0);
	});
});