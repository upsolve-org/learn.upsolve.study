import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";

const { hostedDefault, isHostedDefaultUrl } = await import("../src/core/hosted-default.ts");
const { resolveSettings, resolveSlot, resolveRoleSpec, resolveConversationSpec } = await import("../src/core/settings-resolution.ts");
const { slotsConfigured } = await import("../src/core/settings.ts");

const KEYS = ["HOSTED_MODE", "HOSTED_DEFAULT_BASE_URL", "HOSTED_DEFAULT_MODEL", "HOSTED_DEFAULT_API_KEY", "HOSTED_DEFAULT_CONTEXT_WINDOW", "HOSTED_DEFAULT_MAX_TOKENS"] as const;
const saved: Record<string, string | undefined> = {};
const complete = {
	HOSTED_MODE: "on",
	HOSTED_DEFAULT_BASE_URL: "https://gateway.example/v1",
	HOSTED_DEFAULT_MODEL: "auto",
	HOSTED_DEFAULT_API_KEY: "sk-secret",
};

function env(values: Record<string, string | undefined>) {
	for (const key of KEYS) {
		const value = key in values ? values[key] : undefined;
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

beforeEach(() => {
	for (const key of KEYS) saved[key] = process.env[key];
	env({});
});
afterEach(() => {
	for (const key of KEYS) {
		if (saved[key] === undefined) delete process.env[key];
		else process.env[key] = saved[key];
	}
});

describe("hosted default", () => {
	it("is off without hosted mode, even when fully configured", () => {
		env({ ...complete, HOSTED_MODE: "off" });
		assert.equal(hostedDefault(), undefined);
	});

	it("requires all three values", () => {
		for (const missing of ["HOSTED_DEFAULT_BASE_URL", "HOSTED_DEFAULT_MODEL", "HOSTED_DEFAULT_API_KEY"]) {
			env({ ...complete, [missing]: "" });
			assert.equal(hostedDefault(), undefined, missing);
		}
	});

	it("returns the configured endpoint when complete", () => {
		env(complete);
		assert.deepEqual(hostedDefault(), {
			baseUrl: "https://gateway.example/v1", model: "auto", apiKey: "sk-secret",
			contextWindow: 1_000_000, maxTokens: 1_000_000,
		});
		assert.equal(isHostedDefaultUrl("https://gateway.example/v1"), true);
		assert.equal(isHostedDefaultUrl("https://other.example/v1"), false);
	});

	// REGRESSION (live report 2026-11-18): the default supplied no limits, so the
	// model fell back to 8192/4096. With a 16k compaction reserve that clamped
	// replies to a token or two ("Photos", "I", "Let").
	it("always carries limits big enough for the compaction reserve", () => {
		env(complete);
		const fallback = hostedDefault()!;
		assert.ok(fallback.contextWindow > 16_384, "context must exceed the reserve");
		assert.ok(fallback.maxTokens > 1_000, "output must not be clamped to nothing");
	});

	it("lets the limits be overridden and rejects junk", () => {
		env({ ...complete, HOSTED_DEFAULT_CONTEXT_WINDOW: "200000", HOSTED_DEFAULT_MAX_TOKENS: "8000" });
		assert.equal(hostedDefault()?.contextWindow, 200_000);
		assert.equal(hostedDefault()?.maxTokens, 8_000);
		env({ ...complete, HOSTED_DEFAULT_CONTEXT_WINDOW: "abc", HOSTED_DEFAULT_MAX_TOKENS: "-5" });
		assert.equal(hostedDefault()?.contextWindow, 1_000_000, "junk falls back");
		assert.equal(hostedDefault()?.maxTokens, 1_000_000);
	});
});

describe("the default fills empty slots only", () => {
	it("resolves every slot when the learner configured nothing", () => {
		env(complete);
		const effective = resolveSettings(null);
		for (const slot of ["strong", "cheap", "vision"] as const) {
			assert.equal(effective.models[slot]?.provider, "custom", slot);
			assert.equal(effective.models[slot]?.id, "auto", slot);
		}
	});

	it("reaches background roles through the slot chain", () => {
		env(complete);
		assert.equal(resolveRoleSpec("extractor", null)?.id, "auto");
		assert.equal(resolveRoleSpec("teacher", null)?.id, "auto");
	});

	it("fills the conversation chain used by the turn gate", () => {
		env(complete);
		assert.equal(resolveConversationSpec(undefined, resolveSlot(undefined))?.id, "auto");
	});

	it("lets an explicit learner slot win", () => {
		env(complete);
		const chosen = { strong: { model: { provider: "openrouter", id: "mine" } } };
		assert.equal(resolveSlot(chosen.strong)?.provider, "openrouter");
		assert.equal(resolveSlot(chosen.strong)?.id, "mine");
		// An unset tier still falls back.
		assert.equal(resolveSlot(undefined)?.id, "auto");
	});

	it("lets a per-role override win", () => {
		env(complete);
		const record = { version: 1 as const, agent: { models: { extractor: { model: { provider: "openrouter", id: "cheap-mine" } } } } };
		assert.equal(resolveRoleSpec("extractor", record)?.id, "cheap-mine");
	});

	it("resolves nothing when the default is off", () => {
		env({});
		assert.equal(resolveSlot(undefined), null);
		assert.equal(resolveRoleSpec("teacher", null), undefined);
	});
});

describe("the setup gate", () => {
	it("is satisfied by the default alone", () => {
		env(complete);
		assert.equal(slotsConfigured(undefined), true);
	});

	it("still demands all three slots without a default", () => {
		env({});
		assert.equal(slotsConfigured(undefined), false);
		assert.equal(slotsConfigured({ strong: { model: { provider: "x", id: "y" } } }), false);
	});
});