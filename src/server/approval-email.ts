import { createHash } from "node:crypto";
import { normalizeEmail } from "../core/admission.ts";
import { approveSignup } from "../core/hosted-admission.ts";
import { LOGIN_PATH } from "../core/auth-routes.ts";
import {
	issuedCredentials, provisionAccount, recordCredentialEmail,
	type CredentialEmailDelivery,
} from "../core/hosted-credentials.ts";

type Env = Record<string, string | undefined>;
const approvals = new Map<string, ReturnType<typeof completeApproval>>();

/** Operator authorization is checked by the Server Actions before calling here. */
export async function approveAccount(rawEmail: unknown, env: Env = process.env) {
	const email = normalizeEmail(rawEmail);
	if (!email) return { ok: false as const, error: "Invalid email address." };
	const existing = approvals.get(email);
	if (existing) return existing;
	const approval = completeApproval(email, env).finally(() => approvals.delete(email));
	approvals.set(email, approval);
	return approval;
}

async function completeApproval(email: string, env: Env) {
	approveSignup(email);
	// Repeated approval must not invalidate credentials already sent to the learner.
	if (!issuedCredentials().some(entry => entry.email === email)) {
		const provision = await provisionAccount(email, env);
		if (!provision.ok) return provision;
	}
	return { ok: true as const, delivery: await sendApprovalEmail(email, env) };
}

/** Send only a stored credential. Retrying never creates an account or password. */
export async function sendApprovalEmail(rawEmail: unknown, env: Env = process.env): Promise<CredentialEmailDelivery> {
	const email = normalizeEmail(rawEmail);
	const credential = email ? issuedCredentials().find(entry => entry.email === email) : undefined;
	if (!credential) return { status: "failed", error: "No saved password is available to email." };
	if (credential.emailDelivery?.status === "accepted") return credential.emailDelivery;
	const fail = (error: string): CredentialEmailDelivery => {
		const delivery = { status: "failed" as const, error };
		recordCredentialEmail(credential, delivery);
		return delivery;
	};
	const key = env.RESEND_API_KEY?.trim();
	if (!key) return fail("Approval email is not configured. Set RESEND_API_KEY on the server.");
	let loginUrl: string;
	try {
		const origin = new URL(env.APP_ORIGIN?.trim() || "https://learn.upsolve.study");
		if (origin.protocol !== "https:" || origin.username || origin.password) throw new Error("Invalid origin");
		loginUrl = new URL(LOGIN_PATH, origin).href;
	} catch {
		return fail("The sign-in URL is not configured correctly. Check APP_ORIGIN on the server.");
	}
	const body = JSON.stringify({
		from: env.RESEND_FROM?.trim() || "UPsolve <noreply@upsolve.study>",
		to: [credential.email],
		subject: "Your UPsolve Learn account is ready",
		text: `Your UPsolve Learn account has been approved.\n\nSign in: ${loginUrl}\nEmail: ${credential.email}\nPassword: ${credential.password}\n\nUPsolve`,
	});
	// Resend deduplicates identical requests for 24 hours, including timeout retries.
	// Persisted acceptance prevents later retries too. Only a hash enters the header.
	const idempotencyKey = `approval/${createHash("sha256").update(credential.issuedAt).update(body).digest("hex")}`;
	const response = await fetch("https://api.resend.com/emails", {
		method: "POST",
		headers: {
			authorization: `Bearer ${key}`,
			"content-type": "application/json",
			"Idempotency-Key": idempotencyKey,
		},
		body,
		redirect: "error",
		signal: AbortSignal.timeout(15_000),
	}).catch(() => undefined);
	if (!response) return fail("The email service did not respond. Retry email to check or send the same message.");
	if (!response.ok) {
		// Do not persist provider response bodies: they may echo credentials or secrets.
		if (response.status === 401) return fail("Resend rejected the API key. Check the server email configuration.");
		if (response.status === 403) return fail("Resend refused the sender. Check the verified domain and API key permissions.");
		if (response.status === 429) return fail("Resend is rate limiting requests. Wait a moment, then retry email.");
		return fail(`Resend did not accept the email (HTTP ${response.status}). Retry email.`);
	}
	const result: unknown = await response.json().catch(() => null);
	if (!result || typeof result !== "object" || !("id" in result) || typeof result.id !== "string" || !result.id) {
		return fail("The email service returned an unexpected response. Retry email to check or send the same message.");
	}
	const delivery = { status: "accepted" as const, messageId: result.id, acceptedAt: new Date().toISOString() };
	recordCredentialEmail(credential, delivery);
	return delivery;
}
