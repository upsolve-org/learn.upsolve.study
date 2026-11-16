"use server";

import { revalidatePath } from "next/cache";
import { approveSignup, denySignup } from "@/src/server";
import { isOperator } from "@/src/core";
import { currentAccountEmail } from "@/src/server";

/**
 * Approve or deny a pending request. Operator-only: the address is re-checked
 * here rather than trusted from the form, because the page guard is a render
 * concern and a Server Action can be invoked directly.
 */
async function requireOperator(): Promise<boolean> {
	return isOperator(await currentAccountEmail());
}

export async function approveAction(formData: FormData): Promise<void> {
	if (!(await requireOperator())) return;
	const email = formData.get("email");
	if (typeof email !== "string") return;
	approveSignup(email);
	revalidatePath("/admin");
}

export async function denyAction(formData: FormData): Promise<void> {
	if (!(await requireOperator())) return;
	const email = formData.get("email");
	if (typeof email !== "string") return;
	denySignup(email);
	revalidatePath("/admin");
}