/**
 * THE COMPOSITION ROOT for storage — the single place concrete store
 * adapters are wired. Everything else (core, services, agents) codes against
 * the port types in core/ports.ts and receives instances through this
 * module. Swapping the fs adapter for SQLite later changes exactly this
 * file (and the adapter implementations in src/store/).
 *
 * TENANCY (2026-11-16): the adapters resolve their paths through
 * config.ownerPaths() at call time, so ONE set of store objects serves every
 * learner — the active owner is request state, not an object identity.
 * `withOwner` establishes that state at a request boundary; `forOwner` does
 * the same for background work that carries its owner on the job record.
 */

import { chatStore } from "../store/chats.ts";
import { graphStore } from "../store/graph.ts";
import { sourceOrganizationStore } from "../store/source-organization.ts";
import { jobStore } from "../store/jobs.ts";
import { settingsStore } from "../store/settings.ts";
import { themeStore } from "../store/themes.ts";
import { resolveSettings, type EffectiveSettings } from "../core/settings-resolution.ts";
import { runAsOwner, currentOwnerId } from "../core/owner-scope.ts";
import { syncCustomProvider } from "./custom-provider.ts";
import { configureWorkerRequestAdmission } from "../agent/worker-request-admission.ts";
/** The wired adapters. Satisfies core/graph.ts's GraphDeps structurally. */
export const stores = {
	chatStore,
	graphStore,
	sourceOrganizationStore,
	jobStore,
	settingsStore,
	themeStore,
};

export type Stores = typeof stores;

/**
 * Run `fn` with `owner` active. Everything it awaits or calls synchronously
 * resolves its storage against that owner's root.
 *
 * `owner` undefined runs unscoped (desktop, plain dev, operator-level work) —
 * the legacy data root. A malformed id throws rather than silently escaping
 * the jail.
 */
export function withOwner<T>(owner: string | undefined, fn: () => T): T {
	return owner === undefined ? fn() : runAsOwner(owner, fn);
}

/**
 * Run `fn` with `owner` active, handing it the store set.
 *
 * For background work that has no request (a job carries its owner on the
 * record). The scope is entered for the DURATION of `fn`, which is the point:
 * the adapters are scope-resolving singletons, so merely returning them
 * outside a scope would be useless.
 */
export function forOwner<T>(owner: string | undefined, fn: (stores: Stores) => T): T {
	return withOwner(owner, () => fn(stores));
}

/** The owner of the current scope, for callers that need to key registries. */
export function activeOwner(): string | undefined {
	return currentOwnerId();
}

/**
 * The resolved view of the settings record (core/settings-resolution.ts):
 * every knob concrete over its factory default — EXCEPT MODELS (BYOK all
 * the way down, owner 2026-09-22): no factory pins exist, so unset model
 * slots resolve to null and per-need refusal gates fire downstream. Read
 * fresh on every call — the record is a small file and turns are rare, so
 * no caching layer (stale toggles after a settings PUT would be worse).
 */
export function effectiveSettings(): EffectiveSettings {
	return resolveSettings(settingsStore.readSettings());
}

// Runtime policy is supplied at the composition root, never imported by agents.
configureWorkerRequestAdmission(() => effectiveSettings().agent.workerRequestConcurrency);

// Boot: register the custom endpoint (when configured) into piModels(); the
// POST /api/custom-provider route re-syncs after every connect.
syncCustomProvider();
