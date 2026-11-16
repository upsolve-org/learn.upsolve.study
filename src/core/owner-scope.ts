/**
 * THE OWNER SCOPE — the request-scoped identity every storage path resolves
 * through (tenancy wave, 2026-11-16).
 *
 * The owner is always the VERIFIED session subject (src/core/owner.ts), never
 * a submitted id. The Proxy verifies the session, then forwards the canonical
 * lowercase UUID as an internal request header; the server enters this scope
 * once at the request boundary and every store adapter underneath resolves
 * `ownerPaths()` against it.
 *
 * WHY AsyncLocalStorage and not an argument: the storage ports
 * (src/core/ports.ts) are synchronous, and roughly 1125 test call sites plus
 * the agent tools reach the store singletons with no request context to
 * thread. An async-local association gives per-request isolation without
 * changing a single port signature. Same globalThis discipline as
 * src/agent/background-capture.ts and the server registries: Next compiles
 * each route as its own module instance, so a module-level store would be a
 * DIFFERENT instance in the page render and in the route handler.
 *
 * OUTSIDE any scope (desktop, plain `npm run dev`, and the operator-level
 * auth store) `currentOwnerId()` returns undefined and callers fall back to
 * the legacy unscoped data root — the desktop path stays byte-for-byte.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { isOwnerId, ownerFromUnverified } from "./owner.ts";

interface OwnerScopeGlobal {
	__lhOwnerScope?: AsyncLocalStorage<string>;
}

/** globalThis-anchored so every separately compiled module entry shares ONE scope. */
function scope(): AsyncLocalStorage<string> {
	const g = globalThis as typeof globalThis & OwnerScopeGlobal;
	return (g.__lhOwnerScope ??= new AsyncLocalStorage<string>());
}

/** The canonical owner of the current async context, or undefined outside one. */
export function currentOwnerId(): string | undefined {
	return scope().getStore();
}

/**
 * Run `fn` with `owner` as the active owner. Throws on a non-UUID: a bad
 * value would otherwise become an unchecked path segment.
 */
export function runAsOwner<T>(owner: string, fn: () => T): T {
	const canonical = ownerFromUnverified(owner);
	if (!canonical) throw new Error(`Invalid owner id: ${String(owner)}`);
	return scope().run(canonical, fn);
}

/** The active owner, or a thrown error. For paths that cannot be unscoped. */
export function requireOwnerId(): string {
	const owner = currentOwnerId();
	if (!owner) throw new Error("No owner scope: this operation needs a signed-in owner.");
	return owner;
}

/** Re-export so callers can validate a header without importing owner.ts too. */
export { isOwnerId };