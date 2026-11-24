"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { approveAccount, sendApprovalEmail, denySignup, forgetIssued, provisionAccount } from "@/src/server";
import { isOperator } from "@/src/core";
import { currentAccountEmail } from "@/src/server";

/**
 * Approve or deny a pending request. Operator-only: the address is re-checked
 * here rather than trusted from the form, because the page guard is a render
 * concern and a Server Action can be invoked directly.
 *
 * Approval creates the account and emails its saved password. Sending failures
 * remain visible on the credential, where the operator can retry the email.
 */
async function requireOperator(): Promise<boolean> {
	return isOperator(await currentAccountEmail());
}

export async function approveAction(formData: FormData): Promise<void> {
	if (!(await requireOperator())) return;
	const email = formData.get("email");
	if (typeof email !== "string") return;
	const result = await approveAccount(email);
	revalidatePath("/admin");
	if (!result.ok) redirect("/admin?error=provisioning");
}

export async function retryEmailAction(formData: FormData): Promise<void> {
	if (!(await requireOperator())) return;
	const email = formData.get("email");
	if (typeof email !== "string") return;
	await sendApprovalEmail(email);
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
