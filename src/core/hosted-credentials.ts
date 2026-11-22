/**
 * CREDENTIAL PROVISIONING (2026-11-17).
 *
 * Approving a signup now creates the GoTrue account with a generated password
 * and records it, so the operator can read it back and send it. Supabase keeps
 * only a bcrypt hash, so this store is the ONLY place the plaintext survives.
 *
 * Server-only: needs the secret key and Node fs.
 *
 * `data/issued-credentials.json` is operator-level (outside every owner root)
 * and written 0600 because it holds live passwords.
 */
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { baseDataRoot } from "../../config.ts";
import { hostedConfig } from "./hosted.ts";
import { normalizeEmail } from "./admission.ts";

export interface IssuedCredential {
	email: string;
	password: string;
	userId: string;
	issuedAt: string;
	emailDelivery?: CredentialEmailDelivery;
}

export type CredentialEmailDelivery =
	| { status: "accepted"; messageId: string; acceptedAt: string }
	| { status: "failed"; error: string };

type Env = Record<string, string | undefined>;

function credentialsFile(): string {
	return path.join(/* turbopackIgnore: true */ baseDataRoot(), "issued-credentials.json");
}

/** GoTrue admin base: the internal transport when configured. */
function adminBase(env: Env): string | undefined {
	const config = hostedConfig(env);
	if (!config) return undefined;
	return (env.SUPABASE_INTERNAL_URL ?? config.url).trim().replace(/\/+$/, "");
}

/** The admin key, or undefined when the deployment did not supply one. */
export function adminKey(env: Env = process.env): string | undefined {
	const key = (env.SUPABASE_SECRET_KEY ?? "").trim();
	return key || undefined;
}

/** Is automated provisioning configured? */
export function provisioningAvailable(env: Env = process.env): boolean {
	return Boolean(adminKey(env) && adminBase(env));
}

/**
 * A readable password: alphanumerics only, so it survives copy-paste, shells and
 * URL contexts. 16 bytes of base64url is 22 chars; stripping `-`/`_` can shorten
 * it, so generate extra and slice to a fixed length (~84 bits at 14 chars).
 */
export function generatePassword(): string {
	let out = "";
	while (out.length < 14) out += randomBytes(16).toString("base64url").replace(/[-_]/g, "");
	return out.slice(0, 14);
}

function readIssued(): IssuedCredential[] {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(credentialsFile(), "utf-8"));
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((r): r is IssuedCredential =>
			Boolean(r) && typeof r === "object" &&
			typeof (r as IssuedCredential).email === "string" &&
			typeof (r as IssuedCredential).password === "string");
	} catch {
		return [];
	}
}

function writeIssued(list: IssuedCredential[]): void {
	const file = credentialsFile();
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const temp = `${file}.${process.pid}.tmp`;
	try {
		fs.writeFileSync(temp, `${JSON.stringify(list, null, "\t")}\n`, { mode: 0o600 });
		fs.chmodSync(temp, 0o600);
		fs.renameSync(temp, file);
	} finally {
		fs.rmSync(temp, { force: true });
	}
}

/** Remember a password so the operator can read it back. */
export function recordIssued(entry: IssuedCredential): void {
	const list = readIssued().filter((r) => r.email !== entry.email);
	list.push(entry);
	writeIssued(list);
}

/** Issued credentials, newest first. */
export function issuedCredentials(): IssuedCredential[] {
	return readIssued().sort((a, b) => b.issuedAt.localeCompare(a.issuedAt));
}

/** A delayed send must not restore a forgotten password or overwrite a reset. */
export function recordCredentialEmail(credential: IssuedCredential, delivery: CredentialEmailDelivery): void {
	const list = readIssued();
	const current = list.find(entry => entry.email === credential.email &&
		entry.password === credential.password && entry.issuedAt === credential.issuedAt);
	if (!current || current.emailDelivery?.status === "accepted") return;
	current.emailDelivery = delivery;
	writeIssued(list);
}

/** Forget one address (after handing it over and changing the password). */
export function forgetIssued(email: string): void {
	writeIssued(readIssued().filter((r) => r.email !== email));
}

export type ProvisionResult =
	| { ok: true; credential: IssuedCredential }
	| { ok: false; error: string };

/**
 * Create (or re-password) the GoTrue account for an address and record the
 * password. Idempotent per address: an existing account gets a fresh password
 * rather than an error, so a re-approval always yields usable credentials.
 */
export async function provisionAccount(rawEmail: unknown, env: Env = process.env): Promise<ProvisionResult> {
	const email = normalizeEmail(rawEmail);
	if (!email) return { ok: false, error: "Invalid email address." };
	const key = adminKey(env);
	const base = adminBase(env);
	if (!key || !base) return { ok: false, error: "SUPABASE_SECRET_KEY is not configured; create the account by hand." };

	const password = generatePassword();
	const response = await fetch(`${base}/auth/v1/admin/users`, {
		method: "POST",
		headers: { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json" },
		body: JSON.stringify({ email, password, email_confirm: true }),
		// Never let a redirect silently become an HTML page.
		redirect: "error",
		signal: AbortSignal.timeout(15_000),
	}).catch(() => undefined);
	if (!response) return { ok: false, error: "GoTrue unreachable." };

	const body = await response.json().catch(() => ({})) as { id?: string; msg?: string; error_code?: string };

	// Already exists: reset the password so the operator still gets credentials.
	if (!response.ok && (body.error_code === "email_exists" || /already/i.test(body.msg ?? ""))) {
		const existing = await findUserId(email, base, key);
		if (!existing) return { ok: false, error: "Account exists but its id could not be resolved." };
		const reset = await fetch(`${base}/auth/v1/admin/users/${existing}`, {
			method: "PUT",
			headers: { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json" },
			body: JSON.stringify({ password }),
			redirect: "error",
			signal: AbortSignal.timeout(15_000),
		}).catch(() => undefined);
		if (!reset?.ok) return { ok: false, error: "Account exists but the password reset failed." };
		const credential = { email, password, userId: existing, issuedAt: new Date().toISOString() };
		recordIssued(credential);
		return { ok: true, credential };
	}

	if (!response.ok || !body.id) {
		return { ok: false, error: body.msg ?? `GoTrue returned HTTP ${response.status}.` };
	}
	const credential = { email, password, userId: body.id, issuedAt: new Date().toISOString() };
	recordIssued(credential);
	return { ok: true, credential };
}

/** Look up a user id by address (GoTrue's list is paginated; filter client-side). */
async function findUserId(email: string, base: string, key: string): Promise<string | undefined> {
	const response = await fetch(`${base}/auth/v1/admin/users?per_page=200`, {
		headers: { apikey: key, authorization: `Bearer ${key}` },
		redirect: "error",
		signal: AbortSignal.timeout(15_000),
	}).catch(() => undefined);
	if (!response?.ok) return undefined;
	const body = await response.json().catch(() => ({})) as { users?: { id?: string; email?: string }[] };
	return body.users?.find((u) => normalizeEmail(u.email) === email)?.id;
}
