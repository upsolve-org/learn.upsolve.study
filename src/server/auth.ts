/**
 * AUTHENTICATION SEAM (PR 4) — Better Auth over standalone PostgreSQL.
 *
 * This is the ONLY place that turns a request into a verified user. The Proxy
 * and route handlers pass their request Headers here; server components use
 * next/headers. A test resolver on globalThis lets unit tests stand in for a
 * live database without weakening the production path (it is never set in
 * application code).
 *
 * Password hashing is bcrypt with Supabase's cost 10 so the migrated users'
 * existing $2a$ hashes verify unchanged — zero password resets.
 */
import { headers } from "next/headers";
import { compare, hash } from "bcryptjs";
import { betterAuth, type Auth, type BetterAuthOptions } from "better-auth";
import { nextCookies } from "better-auth/next-js";

// Re-exported so app/ keeps importing ONLY the server barrel (import law).
export { toNextJsHandler } from "better-auth/next-js";
import type { Pool } from "pg";
import { isOperator, normalizeEmail } from "../core/admission.ts";
import { hostedConfig, hostedMode } from "../core/hosted.ts";
import { admittedUser } from "../core/hosted-admission.ts";
import { isOwnerId } from "../core/owner.ts";
import { runAsOwner } from "../core/owner-scope.ts";
import { getPgPool } from "./db.ts";

export type SessionUser = { id: string; email: string };
// The concrete options type is inferred by betterAuth(); the global cache
// stores it behind the general Auth shape (the two differ only in generic
// parameters, not at runtime).
type AuthInstance = Auth<BetterAuthOptions>;
type SessionResolver = (headers: Headers) => Promise<SessionUser | null>;

declare global {
	var __lhBetterAuth: AuthInstance | undefined;
	var __lhAuthSessionResolver: SessionResolver | undefined;
}

/** bcryptjs handles $2a$/$2b$/$2y$ prefixes, including Supabase GoTrue hashes. */
export async function hashPassword(password: string): Promise<string> {
	return hash(password, 10);
}

export async function verifyPassword({ hash: stored, password }: { hash: string; password: string }): Promise<boolean> {
	if (!stored) return false;
	try {
		return await compare(password, stored);
	} catch {
		return false;
	}
}

/** Lazily built: importing this module never opens a database connection. */
export function getAuth(): AuthInstance {
	const cached = globalThis.__lhBetterAuth;
	if (cached) return cached;
	const config = hostedConfig();
	if (!config) throw new Error("HOSTED_MODE is off; auth is unavailable.");
	const auth = betterAuth({
		database: getPgPool(),
		secret: config.secret,
		baseURL: config.origin,
		emailAndPassword: {
			enabled: true,
			disableSignUp: true,
			password: { hash: hashPassword, verify: verifyPassword },
		},
		session: { cookieCache: { enabled: true, maxAge: 5 * 60 } },
		socialProviders: config.googleEnabled
			? { google: { clientId: process.env.GOOGLE_CLIENT_ID!, clientSecret: process.env.GOOGLE_CLIENT_SECRET! } }
			: undefined,
		advanced: { database: { generateId: () => crypto.randomUUID() } },
		// Makes Set-Cookie work from Server Actions (login/sign-out).
		plugins: [nextCookies()],
	});
	globalThis.__lhBetterAuth = auth as unknown as AuthInstance;
	return globalThis.__lhBetterAuth;
}

/** Test seam: a resolver always wins over the live database. */
export function setAuthSessionResolver(fn: SessionResolver | undefined): void {
	globalThis.__lhAuthSessionResolver = fn;
}

/**
 * The verified user for a request, or null. Hosted mode off means no user at
 * all (the desktop/browser gate decides separately). Ids are canonicalised to
 * lowercase UUIDs: they become data/hosted/<owner>/ path segments.
 */
export async function getSessionUser(requestHeaders: Headers): Promise<SessionUser | null> {
	const resolver = globalThis.__lhAuthSessionResolver;
	if (resolver) return resolver(requestHeaders);
	if (!hostedMode()) return null;
	try {
		const session = await getAuth().api.getSession({ headers: requestHeaders });
		if (!session?.user) return null;
		return { id: String(session.user.id).toLowerCase(), email: session.user.email };
	} catch {
		return null;
	}
}

/** The signed-in, admitted owner id — undefined off hosted/signed out. */
export async function currentOwner(): Promise<string | undefined> {
	const user = await getSessionUser(await headers());
	if (!user || !admittedUser(user)) return undefined;
	const id = user.id.toLowerCase();
	return isOwnerId(id) ? id : undefined;
}

/** The signed-in address, admitted or not — the denied page names it. */
export async function currentAccountEmail(): Promise<string | undefined> {
	const user = await getSessionUser(await headers());
	return user?.email;
}

/**
 * Enter the storage scope of the signed-in owner for `fn`.
 *
 * This is the ONE place a request becomes owner-scoped. Unscoped when nobody
 * is signed in, which is the desktop/local path.
 */
export async function asOwner<T>(fn: (owner: string | undefined) => T): Promise<T> {
	const owner = await currentOwner();
	return owner === undefined ? fn(undefined) : runAsOwner(owner, () => fn(owner));
}

export type DatabaseProvisionResult = { ok: true; userId: string } | { ok: false; error: string };

/**
 * Create (or re-password) the auth account without GoTrue's admin API.
 * An existing address keeps its id — that id owns its data directory and
 * cannot change. The password is bcrypt-hashed at Supabase's cost 10 too.
 */
export async function provisionDatabaseUser(email: string, password: string, pool?: Pool): Promise<DatabaseProvisionResult> {
	const normalized = normalizeEmail(email);
	if (!normalized) return { ok: false, error: "Invalid email address." };
	const db = pool ?? getPgPool();
	const client = await db.connect();
	try {
		await client.query("BEGIN");
		await client.query(
			`INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
			 VALUES ($1, $2, $3, TRUE, NOW(), NOW())
			 ON CONFLICT (email) DO NOTHING`,
			[crypto.randomUUID(), normalized, normalized],
		);
		// Read back the authoritative id: a concurrent approval may have won.
		const { rows } = await client.query<{ id: string }>('SELECT id FROM "user" WHERE email = $1', [normalized]);
		const userId = rows[0]?.id;
		if (!userId) throw new Error("User row not found after provisioning.");
		await client.query(
			`INSERT INTO "account" (id, "providerId", "accountId", "userId", password, "createdAt", "updatedAt")
			 VALUES ($1, 'credential', $2, $3, $4, NOW(), NOW())
			 ON CONFLICT ("providerId", "accountId")
			 DO UPDATE SET password = EXCLUDED.password, "userId" = EXCLUDED."userId", "updatedAt" = NOW()`,
			[crypto.randomUUID(), userId, userId, await hashPassword(password)],
		);
		await client.query("COMMIT");
		return { ok: true, userId };
	} catch {
		await client.query("ROLLBACK");
		return { ok: false, error: "Account provisioning failed." };
	} finally {
		client.release();
	}
}

const refusal = (error: string, status: number): Response =>
	Response.json({ error }, { status, headers: { "Cache-Control": "no-store" } });

/**
 * Verify the request's session and admit it. Returns the canonical owner id
 * on success, or the refusal Response. The id is FORWARDED to routes: the
 * Proxy's API gate is the only gate most routes ever see.
 */
export async function hostedIdentityFromHeaders(
	requestHeaders: Headers,
): Promise<{ owner: string; operator: boolean } | { refusal: Response }> {
	// Hosted mode off (desktop, plain dev): no owner AND no refusal — the
	// caller's own desktop/browser gate already decided. No operator either.
	if (!hostedMode()) return { owner: "", operator: false };
	let user: SessionUser | null;
	try {
		user = await getSessionUser(requestHeaders);
	} catch {
		return { refusal: refusal("Authentication is temporarily unavailable.", 503) };
	}
	if (!user) return { refusal: refusal("Sign in with an admitted account.", 401) };
	if (!admittedUser(user)) return { refusal: refusal("Sign in with an admitted account.", 403) };
	return { owner: user.id.toLowerCase(), operator: isOperator(user.email) };
}

/** The upload exemption must enforce the same verified identity as Proxy. */
export async function hostedRequestRefusal(request: Request): Promise<Response | undefined> {
	const result = await hostedIdentityFromHeaders(request.headers);
	return "refusal" in result ? result.refusal : undefined;
}
