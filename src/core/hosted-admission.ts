/**
 * ADMISSION — who may have a workspace (tenancy wave, 2026-11-16).
 *
 * Two files, both operator-owned and outside any owner scope:
 *
 *   data/admissions.json  { version: 1, emails: [...] }   — the allowlist
 *   data/signups.json     { version: 1, requests: [...] } — the pending queue
 *
 * A signup only QUEUES an address. Nothing is admitted until the operator
 * approves it on /admin, so a stranger who reaches the form cannot consume a
 * workspace unreviewed. Signups stay closed in GoTrue itself; the operator
 * still creates the account and mails the credentials by hand.
 *
 * Admission is by verified EMAIL, not by id: the operator knows addresses, and
 * the id only exists once the account does. The email is read from the
 * GoTrue-verified user object, never from a request body.
 *
 * `HOSTED_PILOT_EMAIL` stays honoured as an implicit extra entry so an
 * existing deployment keeps working through the upgrade.
 */
import { createServerClient, parseCookieHeader } from "@supabase/ssr";
import path from "node:path";
import fs from "node:fs";
import { baseDataRoot } from "../../config.ts";
import { hostedConfig } from "./hosted.ts";
import { hostedFetch } from "./hosted-fetch.ts";
import { isOwnerId } from "./owner.ts";
import { isOperator, normalizeEmail, type SignupOutcome, type SignupRequest } from "./admission.ts";

export { normalizeEmail, isOperator, type SignupOutcome, type SignupRequest } from "./admission.ts";

/** Operator-level files: deliberately NOT under an owner root. */
function admissionsFile(): string {
	return path.join(/* turbopackIgnore: true */ baseDataRoot(), "admissions.json");
}

function signupsFile(): string {
	return path.join(/* turbopackIgnore: true */ baseDataRoot(), "signups.json");
}

interface AdmissionsFile {
	version: 1;
	emails: string[];
}

interface SignupsFile {
	version: 1;
	requests: SignupRequest[];
}

function readJson<T>(file: string, fallback: T): T {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return fallback;
		return parsed as T;
	} catch {
		return fallback;
	}
}

/** The allowlist. Corrupt/absent reads as empty — admission then denies. */
export function admittedEmails(): string[] {
	const raw = readJson<Partial<AdmissionsFile>>(admissionsFile(), {});
	const listed = Array.isArray(raw.emails) ? raw.emails : [];
	const emails = listed.map(normalizeEmail).filter((e): e is string => e !== undefined);
	const pilot = normalizeEmail(process.env.HOSTED_PILOT_EMAIL);
	if (pilot && !emails.includes(pilot)) emails.push(pilot);
	return emails;
}

/** Is this verified user admitted? An id is required too: a token without a
 *  usable subject cannot own a storage root. */
export function admittedUser(user: { id: string; email?: string }): boolean {
	const email = normalizeEmail(user.email);
	return Boolean(email) && isOwnerId(user.id) && admittedEmails().includes(email!);
}

/** Kept as the historical name for the single-account era. */
export function pilotUserAllowed(user: { id: string; email?: string }, _email = process.env.HOSTED_PILOT_EMAIL): boolean {
	return admittedUser(user);
}

function writeJson(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const temp = `${file}.${process.pid}.tmp`;
	try {
		// 0644, not 0600: these files hold no secrets, and they are written by
		// whichever account runs the tool that approves a request (often root
		// over SSH) while the SERVER reads them as its own user. A 0600 file
		// would fail closed for the app with no visible error.
		fs.writeFileSync(temp, `${JSON.stringify(value, null, "\t")}\n`, { mode: 0o644 });
		fs.chmodSync(temp, 0o644);
		fs.renameSync(temp, file);
	} finally {
		fs.rmSync(temp, { force: true });
	}
}

/** Pending signup requests, oldest first. */
export function pendingSignups(): SignupRequest[] {
	const raw = readJson<Partial<SignupsFile>>(signupsFile(), {});
	const requests = Array.isArray(raw.requests) ? raw.requests : [];
	return requests
		.filter((r): r is SignupRequest => Boolean(r) && typeof r === "object" && typeof r.email === "string")
		.sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
}

/** Queue an address for review. Idempotent: a repeat request is not duplicated. */
export function requestSignup(rawEmail: unknown): SignupOutcome | undefined {
	const email = normalizeEmail(rawEmail);
	if (!email) return undefined;
	if (admittedEmails().includes(email)) return "already-admitted";
	const requests = pendingSignups();
	if (requests.some((r) => r.email === email)) return "already-pending";
	requests.push({ email, requestedAt: new Date().toISOString() });
	writeJson(signupsFile(), { version: 1, requests } satisfies SignupsFile);
	return "queued";
}

/** Approve: move an address from the queue into the allowlist. */
export function approveSignup(rawEmail: unknown): boolean {
	const email = normalizeEmail(rawEmail);
	if (!email) return false;
	const emails = admittedEmails();
	if (!emails.includes(email)) {
		emails.push(email);
		writeJson(admissionsFile(), { version: 1, emails } satisfies AdmissionsFile);
	}
	const requests = pendingSignups().filter((r) => r.email !== email);
	writeJson(signupsFile(), { version: 1, requests } satisfies SignupsFile);
	return true;
}

/** Deny: drop an address from the queue without admitting it. */
export function denySignup(rawEmail: unknown): boolean {
	const email = normalizeEmail(rawEmail);
	if (!email) return false;
	const requests = pendingSignups().filter((r) => r.email !== email);
	writeJson(signupsFile(), { version: 1, requests } satisfies SignupsFile);
	return true;
}


/**
 * Verify the request's session and admit it. Returns the canonical owner id on
 * success, or the refusal Response.
 *
 * The id is returned (not just a verdict) because the caller has to FORWARD it
 * to the route: the Proxy's API gate is the only gate most routes see, and a
 * route that never learns the owner would read the shared root.
 */
export async function hostedIdentity(
	request: Request,
): Promise<{ owner: string; operator: boolean } | { refusal: Response }> {
	const config = hostedConfig();
	// Hosted mode off (desktop, plain dev): no owner, and NOT a refusal — the
	// caller's own desktop/browser gate already decided. No operator either:
	// the operator gates are hosted-only.
	if (!config) return { owner: "", operator: false };
	const cookies = parseCookieHeader(request.headers.get("cookie") ?? "");
	const client = createServerClient(config.url, config.publishableKey, {
		global: { fetch: hostedFetch(config.url) },
		cookies: { getAll: () => cookies, setAll: () => {} },
	});
	try {
		const { data, error } = await client.auth.getUser();
		if (!error && data.user && admittedUser(data.user)) {
			return { owner: data.user.id.toLowerCase(), operator: isOperator(data.user.email) };
		}
		return { refusal: Response.json({ error: "Sign in with an admitted account." }, { status: data.user ? 403 : 401, headers: { "Cache-Control": "no-store" } }) };
	} catch {
		return { refusal: Response.json({ error: "Authentication is temporarily unavailable." }, { status: 503, headers: { "Cache-Control": "no-store" } }) };
	}
}

/** The upload exemption must enforce the same verified identity as Proxy. */
export async function hostedRequestRefusal(request: Request): Promise<Response | undefined> {
	const result = await hostedIdentity(request);
	return "refusal" in result ? result.refusal : undefined;
}