"use server";

import { requestSignup } from "@/src/server";
import { normalizeEmail, type SignupOutcome } from "@/src/core";

export type SignupState = { outcome?: SignupOutcome; error?: string };

/**
 * POST /auth/signup — queue an address for operator review.
 *
 * Deliberately creates NOTHING: no GoTrue account, no workspace. The operator
 * approves on /admin, creates the account, and mails the credentials. That
 * keeps the invite boundary intact while still giving a stranger a way to ask.
 */
export async function requestAccountAction(_previous: SignupState, formData: FormData): Promise<SignupState> {
	const email = normalizeEmail(formData.get("email"));
	if (!email) return { error: "Enter a valid email address." };
	const outcome = requestSignup(email);
	if (!outcome) return { error: "Enter a valid email address." };
	return { outcome };
}