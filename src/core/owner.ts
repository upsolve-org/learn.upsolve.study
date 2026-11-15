/**
 * The owner: the ONLY identity the server ever trusts under hosted mode.
 *
 * It is always the verified `sub` of the session access token, never a
 * submitted id, never a header, never the unverified `user_metadata`.
 * Verification is local against the GoTrue JWKS (ES256) so a request costs
 * no network round trip, and the result is canonicalised to a lowercase
 * UUID because it also becomes a path segment
 * (data/hosted/<owner>/).
 */
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

type Env = Record<string, string | undefined>;

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

/** Claims a hosted request carries: the verified user id plus the signed
 * claims the database policies evaluate (request.jwt.claims). */
export type VerifiedClaims = {
	sub: string;
	role: string;
	email?: string;
	/** The raw verified claims, replayed into the DB session. */
	raw: JWTPayload;
};

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function jwksFor(env: Env): ReturnType<typeof createRemoteJWKSet> {
	const base = (env.SUPABASE_INTERNAL_URL ?? env.NEXT_PUBLIC_SUPABASE_URL ?? "").trim().replace(/\/+$/, "");
	if (!base) throw new Error("NEXT_PUBLIC_SUPABASE_URL is unset; cannot verify a session.");
	let set = jwksCache.get(base);
	if (!set) {
		// Asymmetric (ES256) signing only: opaque API keys never reach here.
		set = createRemoteJWKSet(new URL(`${base}/auth/v1/.well-known/jwks.json`));
		jwksCache.set(base, set);
	}
	return set;
}

/**
 * Verify an access token. Returns undefined for anything unverifiable:
 * wrong signature, expired, wrong issuer, foreign audience.
 */
export async function verifyAccessToken(
	token: string,
	env: Env = process.env,
): Promise<VerifiedClaims | undefined> {
	const base = (env.NEXT_PUBLIC_SUPABASE_URL ?? "").trim().replace(/\/+$/, "");
	if (!base || !token) return undefined;
	try {
		const { payload } = await jwtVerify(token, jwksFor(env), {
			issuer: `${base}/auth/v1`,
			audience: "authenticated",
			algorithms: ["ES256"],
		});
		const sub = ownerFromUnverified(payload.sub);
		if (!sub) return undefined;
		return {
			sub,
			role: typeof payload.role === "string" ? payload.role : "authenticated",
			email: typeof payload.email === "string" ? payload.email : undefined,
			raw: payload,
		};
	} catch {
		return undefined;
	}
}

/**
 * Test seam: verify an already-decoded claim set without a JWKS fetch.
 * Mirrors the checks above closely enough for unit tests of the owner
 * plumbing; every hosted integration suite still uses real tokens.
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
