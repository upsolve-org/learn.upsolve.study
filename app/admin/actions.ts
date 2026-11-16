"use server";

import { revalidatePath } from "next/cache";
import { approveSignup, denySignup, forgetIssued, provisionAccount } from "@/src/server";
import { isOperator } from "@/src/core";
import { currentAccountEmail } from "@/src/server";

/**
 * Approve or deny a pending request. Operator-only: the address is re-checked
 * here rather than trusted from the form, because the page guard is a render
 * concern and a Server Action can be invoked directly.
 *
 * Approval also CREATES the GoTrue account with a generated password and
 * records it, so the operator can read the credentials off the page and send
 * them. If provisioning fails the address stays admitted — the account can
 * still be made by hand, and the page says so.
 */
async function requireOperator(): Promise<boolean> {
	return isOperator(await currentAccountEmail());
}

export async function approveAction(formData: FormData): Promise<void> {
	if (!(await requireOperator())) return;
	const email = formData.get("email");
	if (typeof email !== "string") return;
	approveSignup(email);
	await provisionAccount(email);
	revalidatePath("/admin");
}

export async function denyAction(formData: FormData): Promise<void> {
	if (!(await requireOperator())) return;
	const email = formData.get("email");
	if (typeof email !== "string") return;
	denySignup(email);
	revalidatePath("/admin");
}

/** Re-generate a password for an already-approved address. */
export async function reprovisionAction(formData: FormData): Promise<void> {
	if (!(await requireOperator())) return;
	const email = formData.get("email");
	if (typeof email !== "string") return;
	await provisionAccount(email);
	revalidatePath("/admin");
}

/** Drop a stored password once it has been handed over. */
export async function forgetCredentialAction(formData: FormData): Promise<void> {
	if (!(await requireOperator())) return;
	const email = formData.get("email");
	if (typeof email !== "string") return;
	forgetIssued(email);
	revalidatePath("/admin");
}