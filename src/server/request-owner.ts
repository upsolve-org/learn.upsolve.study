/**
 * THE REQUEST BOUNDARY for owner scoping (tenancy wave, 2026-11-16).
 *
 * The Proxy verifies the session and forwards the canonical owner id as an
 * internal header. This module is the ONE place a route handler or server
 * component turns that header into an active storage scope
 * (src/core/owner-scope.ts), so every store call underneath resolves against
 * the owner's root.
 *
 * Why a header and not AsyncLocalStorage set in the Proxy: the Proxy and the
 * route run in separate async contexts, so a store set there does not survive
 * into the handler. The header is the documented carrier between the two.
 *
 * Why the wrapper stays SYNCHRONOUS: route handlers receive the Request as
 * their first argument, so the owner is one synchronous header read. Keeping
 * the signature unchanged matters — handlers stay `Response`, not
 * `Promise<Response>`, and existing direct-call tests keep working.
 *
 * Unscoped when hosted mode is off or nobody is signed in: the desktop and
 * plain-dev paths keep the legacy data root byte-for-byte.
 */
import { headers } from "next/headers";
import { runAsOwner } from "../core/owner-scope.ts";
import { isOwnerId } from "../core/owner.ts";
import { hostedMode } from "../core/hosted.ts";

export const OWNER_HEADER = "x-lh-owner";
/** Internal capability header. The Proxy sets it to "1" for the operator only. */
export const OPERATOR_HEADER = "x-lh-operator";

/** Canonicalise a header value, or undefined when it is not a usable id. */
function ownerOf(value: string | null | undefined): string | undefined {
	if (!value) return undefined;
	const owner = value.trim().toLowerCase();
	return isOwnerId(owner) ? owner : undefined;
}

/**
 * The verified owner carried by `request`, or undefined.
 *
 * In hosted mode a missing/invalid header is a hard undefined: the Proxy
 * always sets it for an admitted request, so its absence means the request
 * slipped past the gate and must not silently read the shared root.
 */
export function ownerOfRequest(request: Request | undefined): string | undefined {
	if (!hostedMode()) return undefined;
	return ownerOf(request?.headers.get(OWNER_HEADER));
}

/**
 * Wrap a route handler so its body runs inside the caller's owner scope.
 * Arguments and the return value pass through untouched, and a synchronous
 * handler stays synchronous.
 *
 * The owner is read from the first argument when it is a Request. A handler
 * with no Request (only possible for a route that reads nothing) simply runs
 * unscoped.
 */
export function ownerScoped<A extends unknown[], R>(
	handler: (...args: A) => R,
): (...args: A) => R {
	return (...args: A): R => {
		const owner = ownerOfRequest(args[0] instanceof Request ? args[0] : undefined);
		return owner === undefined ? handler(...args) : runAsOwner(owner, () => handler(...args));
	};
}

/**
 * Is this request from the operator? Desktop/plain-dev has one user who owns
 * everything, so the operator gates are inert there. In hosted mode the ONLY
 * trusted signal is the Proxy-set header — it is stripped from client input
 * before forwarding (proxy.ts), so a forged header cannot reach a route.
 */
export function isOperatorRequest(request: Request | undefined): boolean {
	if (!hostedMode()) return true;
	return request?.headers.get(OPERATOR_HEADER) === "1";
}

/** A 403 refusal for a non-operator in hosted mode; otherwise no refusal. */
export function operatorRefusal(request: Request | undefined): Response | undefined {
	if (isOperatorRequest(request)) return undefined;
	return Response.json({ error: "Operator access required." }, {
		status: 403,
		headers: { "Cache-Control": "no-store" },
	});
}

/**
 * Operator-only route wrapper: refuse BEFORE entering any owner scope, then
 * run the handler exactly as `ownerScoped` would. The refusal happens on the
 * capability, not on identity — when hosted mode is off every request is an
 * operator request and the wrapper is a transparent pass-through.
 */
export function operatorOnly<A extends unknown[], R>(
	handler: (...args: A) => R,
): (...args: A) => R | Response {
	const scoped = ownerScoped(handler);
	return (...args: A): R | Response => {
		const refusal = operatorRefusal(args[0] instanceof Request ? args[0] : undefined);
		if (refusal) return refusal;
		return scoped(...args);
	};
}

/**
 * The owner for a SERVER COMPONENT, which has no Request argument and must
 * therefore read `headers()` asynchronously. Pages call this once and do
 * their store reads inside the callback.
 */
export async function asRequestOwner<T>(fn: (owner: string | undefined) => T): Promise<T> {
	if (!hostedMode()) return fn(undefined);
	const owner = ownerOf((await headers()).get(OWNER_HEADER));
	return owner === undefined ? fn(undefined) : runAsOwner(owner, () => fn(owner));
}