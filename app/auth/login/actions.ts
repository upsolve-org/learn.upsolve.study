"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getAuth } from "@/src/server";
import { hostedConfig, hostedMode, LOGIN_PATH, safeReturnPath } from "@/src/core";

export type LoginState = { error?: string; notice?: string };

/** Email + password only while Google is off; both once it is on. Pure config:
 *  no network probe to an auth provider at render time. */
export async function loginProviders(): Promise<boolean> {
	return hostedConfig()?.googleEnabled === true;
}

/** Only the codes the page can explain; everything else is generic. */
function codeFor(message: string): string {
	const text = message.toLowerCase();
	if (text.includes("invalid")) return "invalid_credentials";
	if (text.includes("confirm")) return "email_not_confirmed";
	if (text.includes("rate") || text.includes("too many")) return "rate_limit";
	return "invalid_credentials";
}

/** POST /auth/login - email/password via Better Auth, then home (or ?next). */
export async function signInAction(_previous: LoginState, formData: FormData): Promise<LoginState> {
	const next = safeReturnPath(String(formData.get("next") ?? ""));
	const email = String(formData.get("email") ?? "").trim();
	const password = String(formData.get("password") ?? "");
	if (!email || !password) return { error: "Enter your email and password." };
	if (!hostedMode()) return { error: "This build has no accounts (HOSTED_MODE is off)." };

	try {
		// nextCookies() writes the session cookie into this action's response.
		await getAuth().api.signInEmail({ body: { email, password }, headers: await headers() });
	} catch (error) {
		const message = error instanceof Error ? error.message : "";
		const back = new URLSearchParams({ next, error: codeFor(message) });
		redirect(`${LOGIN_PATH}?${back}`);
	}

	revalidatePath("/", "layout");
	redirect(next);
}

/** POST /auth/login with intent=google - Better Auth's OAuth redirect. Hidden
 *  until Google credentials are configured; the page only renders it then. */
export async function googleSignInAction(formData: FormData): Promise<void> {
	const config = hostedConfig();
	const next = safeReturnPath(String(formData.get("next") ?? ""));
	if (!config?.googleEnabled) {
		redirect(`${LOGIN_PATH}?${new URLSearchParams({ next, error: "oauth" })}`);
	}
	let url: string | undefined;
	try {
		const result = await getAuth().api.signInSocial({
			body: { provider: "google", callbackURL: next },
			headers: await headers(),
		});
		url = result?.url;
	} catch {
		// Fall through to the generic OAuth error below. redirect() throws a
		// control-flow error, so it must stay OUTSIDE this catch.
	}
	if (!url) redirect(`${LOGIN_PATH}?error=oauth&next=${encodeURIComponent(next)}`);
	redirect(url);
}
