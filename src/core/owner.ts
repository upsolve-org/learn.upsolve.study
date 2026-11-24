/**
 * The owner: the ONLY identity the server ever trusts under hosted mode.
 *
 * It is always the verified session user's id from Better Auth, never a
 * submitted id, never a header. It is canonicalised to a lowercase UUID
 * because it also becomes a path segment (data/hosted/<owner>/).
 *
 * Session verification itself lives in src/server/auth.ts (it needs the
 * database); the pure vocabulary here is shared with tests and the core.
 */
import type { JWTPayload } from "jose";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isOwnerId(value: unknown): value is string {
	return typeof value === "string" && UUID.test(value);
}

/** Canonical form, or undefined when the value is not a UUID. */
export function ownerFromUnverified(value: unknown): string | undefined {
	if (typeof value !== "string") return;
	const lowered = value.trim().toLowerCase();
	return isOwnerId(lowered) ? lowered : undefined;
}

/** Claims a hosted request carries: the verified user id and its scope. */
export type VerifiedClaims = {
	sub: string;
	role: string;
	email?: string;
	raw: JWTPayload;
};

/**
 * Test seam: build claims from an already-decoded payload. Mirrors the
 * canonicalisation the live session path applies; every hosted integration
 * suite still uses a real session resolver.
 */
export function unverifiedClaimsForTest(payload: JWTPayload): VerifiedClaims | undefined {
	const sub = ownerFromUnverified(payload.sub);
	if (!sub) return undefined;
	return {
		sub,
		role: typeof payload.role === "string" ? payload.role : "authenticated",
		email: typeof payload.email === "string" ? payload.email : undefined,
		raw: payload,
	};
}
