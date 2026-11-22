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
import { FACTORY_SETTINGS, type UserSettings } from "../core/settings.ts";
import { runAsOwner, currentOwnerId } from "../core/owner-scope.ts";
import { hostedMode } from "../core/hosted.ts";
import { hasDatabaseUrl } from "./db.ts";
import { syncCustomProvider } from "./custom-provider.ts";
import { configureWorkerRequestAdmission } from "../agent/worker-request-admission.ts";
export interface Stores {
	chatStore: typeof chatStore;
	graphStore: typeof graphStore;
	sourceOrganizationStore: typeof sourceOrganizationStore;
	jobStore: typeof jobStore;
	settingsStore: typeof settingsStore;
	themeStore: typeof themeStore;
}

const active: Stores = {
	chatStore,
	graphStore,
	sourceOrganizationStore,
	jobStore,
	settingsStore,
	themeStore,
};

const liveProxies = new WeakSet<object>();

/**
 * Each store on `stores` is a live delegating Proxy over `active[key]`.
 * Several composition roots (`jobRunner`, `extraction`, `sideChats`, plugins)
 * capture `stores.chatStore` / `{ ...stores }` at module-import time, BEFORE
 * `instrumentation.ts` or `scripts/worker.ts` calls `configureStores(...)`.
 * Delegating through a stable proxy ensures every captured reference swaps
 * cleanly onto PostgreSQL (or test doubles) without re-initializing singletons.
 */
function liveStore<K extends keyof Stores>(key: K): Stores[K] {
	const proxy = new Proxy({} as Stores[K], {
		get(_target, prop) {
			const target = active[key] as unknown as Record<PropertyKey, unknown>;
			const value = Reflect.get(target, prop, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
		set(_target, prop, value) {
			return Reflect.set(active[key] as unknown as Record<PropertyKey, unknown>, prop, value);
		},
		has(_target, prop) {
			return prop in (active[key] as object);
		},
		ownKeys() {
			return Reflect.ownKeys(active[key] as object);
		},
		getOwnPropertyDescriptor(_target, prop) {
			const desc = Reflect.getOwnPropertyDescriptor(active[key] as object, prop);
			return desc ? { ...desc, configurable: true } : undefined;
		},
	});
	liveProxies.add(proxy as object);
	return proxy;
}

/** The wired adapters. Satisfies core/graph.ts's GraphDeps structurally. */
export const stores: Stores = {
	chatStore: liveStore("chatStore"),
	graphStore: liveStore("graphStore"),
	sourceOrganizationStore: liveStore("sourceOrganizationStore"),
	jobStore: liveStore("jobStore"),
	settingsStore: liveStore("settingsStore"),
	themeStore: liveStore("themeStore"),
};

/**
 * Which storage backend this process uses (PR 5). Explicit `postgres` opts
 * in; hosted mode with a database opts in by default; an explicit `fs` is
 * always honored (tests and local dev). Kept here — the composition root —
 * because both boot (instrumentation.ts) and the job queue need the SAME
 * answer, and it must be a pure function of env so tests can pin it.
 */
export function postgresStorageEnabled(env: Record<string, string | undefined> = process.env): boolean {
	return env.STORAGE_BACKEND === "postgres"
		|| (hostedMode(env) && hasDatabaseUrl(env) && env.STORAGE_BACKEND !== "fs");
}

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
/**
 * Cached so the synchronous worker-admission policy seam can read it.
 * Refreshed on every effectiveSettings() read (a settings PUT re-reads before
 * the next turn), and bootstrapped from the factory so the very first read
 * is valid even before settings are loaded.
 */
let cachedWorkerConcurrency: number = FACTORY_SETTINGS.agent.workerRequestConcurrency;

/**
 * Per-owner last-known settings record. Several synchronous seams (cache
 * retention, worker concurrency, search gating, Claude Code admission,
 * background consent) cannot await an async store adapter, so they read
 * through cachedSettings() instead. Keyed by owner — tenancy means one set
 * of store objects serves every learner, and a sync read must never observe
 * another owner's record.
 */
const settingsByOwner = new Map<string, UserSettings | null>();
const settingsCacheKey = (): string => currentOwnerId() ?? "__default__";
/** Once a read returns a promise we're on an async backend; from then on the
 *  sync seams must use the cache (reading on every call would re-query the
 *  database). With a sync adapter we keep the historical read-fresh behavior. */
let settingsAsync = false;

/** Refresh the per-owner cache from the authoritative read. Writes call
 *  invalidateCachedSettings() first so the next read is always current. */
export async function effectiveSettings(): Promise<EffectiveSettings> {
	const record = await stores.settingsStore.readSettings();
	settingsByOwner.set(settingsCacheKey(), record);
	const effective = resolveSettings(record);
	cachedWorkerConcurrency = effective.agent.workerRequestConcurrency;
	return effective;
}

/**
 * The last-known settings record for the current owner, for seams that must
 * stay synchronous. Never throws under an async backend: when the adapter
 * returns a promise, a background `.then` populates the cache and this call
 * returns null (the honest "not loaded yet" answer) rather than failing
 * loudly. Sync adapters populate immediately.
 */
export function cachedSettings(): UserSettings | null {
	const key = settingsCacheKey();
	if (settingsAsync) {
		const cached = settingsByOwner.get(key);
		if (cached !== undefined) return cached ?? null;
	}
	const value = stores.settingsStore.readSettings();
	if (value !== null && typeof value === "object" && typeof (value as PromiseLike<UserSettings | null>).then === "function") {
		settingsAsync = true;
		void (value as Promise<UserSettings | null>).then(
			(resolved) => { settingsByOwner.set(key, resolved); },
			() => { /* a failed background read leaves this owner uncached */ },
		);
		return settingsByOwner.get(key) ?? null;
	}
	const sync = value as UserSettings | null;
	settingsByOwner.set(key, sync);
	return sync;
}

/** Drop the current owner's cached record after a settings write. The route
 *  then calls effectiveSettings() to repopulate from the authoritative read. */
export function invalidateCachedSettings(): void {
	settingsByOwner.delete(settingsCacheKey());
}

/** Swap one or more adapters (PR 5 Postgres wiring / tests). Because every
 *  entry on `stores` is a live Proxy over `active`, callers that captured
 *  `stores.chatStore` at module-import time (like `jobRunner` and `extraction`)
 *  also see the swap immediately. Returns a restore callback for tests. */
export function configureStores(next: Partial<Stores>): () => void {
	const previous: Partial<Stores> = {};
	for (const key of Object.keys(active) as Array<keyof Stores>) {
		const value = next[key];
		if (!value || liveProxies.has(value as object)) continue;
		(previous as Record<keyof Stores, unknown>)[key] = active[key];
		(active as Record<keyof Stores, unknown>)[key] = value;
	}
	settingsByOwner.clear();
	settingsAsync = false;
	return () => {
		Object.assign(active, previous);
		settingsByOwner.clear();
		settingsAsync = false;
	};
}

// Runtime policy is supplied at the composition root, never imported by agents.
configureWorkerRequestAdmission(() => cachedWorkerConcurrency);

// Boot: register the custom endpoint (when configured) into piModels(); the
// POST /api/custom-provider route re-syncs after every connect.
syncCustomProvider();
