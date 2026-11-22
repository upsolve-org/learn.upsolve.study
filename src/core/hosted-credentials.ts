/**
 * CREDENTIAL PROVISIONING (2026-11-17).
 *
 * Approving a signup creates the auth account with a generated password and
 * records it, so the operator can read it back and send it. Better Auth keeps
 * only a bcrypt hash, so this store is the ONLY place the plaintext survives.
 *
 * This module is pure core (fs only): the actual account write is injected as
 * an AccountProvisioner by the server barrel, which keeps provisioning
 * testable without a live PostgreSQL database.
 *
 * `data/issued-credentials.json` is operator-level (outside every owner root)
 * and written 0600 because it holds live passwords.
 */
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { baseDataRoot } from "../../config.ts";
import { hostedMode } from "./hosted.ts";
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

/**
 * The server-side write step: create/reset the account for an address with
 * the supplied plaintext. Kept as a port so core stays free of DB imports.
 */
export type AccountProvisioner = (
	email: string,
	password: string,
	env: Env,
) => Promise<{ ok: true; userId: string } | { ok: false; error: string }>;

/** Is automated provisioning configured? Mirrors hasDatabaseUrl() from the
 *  server barrel — core cannot import it (import law), and the check is the
 *  same non-empty DATABASE_URL trim. */
export function provisioningAvailable(env: Env = process.env): boolean {
	return hostedMode(env) && Boolean(env.DATABASE_URL?.trim());
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
 * Create (or re-password) the account for an address and record the password.
 * Idempotent per address: the injected provisioner preserves an existing id
 * and resets its password, so a re-approval always yields usable credentials.
 */
export async function provisionAccount(
	rawEmail: unknown,
	env: Env = process.env,
	provisioner?: AccountProvisioner,
): Promise<ProvisionResult> {
	const email = normalizeEmail(rawEmail);
	if (!email) return { ok: false, error: "Invalid email address." };
	if (!provisioner) {
		return { ok: false, error: "DATABASE_URL is not configured; create the account by hand." };
	}
	const password = generatePassword();
	let result: Awaited<ReturnType<AccountProvisioner>>;
	try {
		result = await provisioner(email, password, env);
	} catch {
		return { ok: false, error: "Account provisioning failed." };
	}
	if (!result.ok) return { ok: false, error: result.error };
	const credential = { email, password, userId: result.userId, issuedAt: new Date().toISOString() };
	recordIssued(credential);
	return { ok: true, credential };
}
