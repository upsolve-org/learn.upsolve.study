"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { supabaseServer } from "@/src/server";
import { CALLBACK_PATH, hostedConfig, hostedMode, LOGIN_PATH, safeReturnPath } from "@/src/core";
import { hostedFetch } from "@/src/server";

export type LoginState = { error?: string; notice?: string };

/** Email + password only while Google is off; both once it is on. */
export async function loginProviders(): Promise<boolean> {
	const config = hostedConfig();
	if (!config) return false;
	try {
		const response = await hostedFetch(config.url)(`${config.url}/auth/v1/settings`, {
			headers: { apikey: config.publishableKey },
			cache: "no-store",
		});
		if (!response.ok) return false;
		const settings = (await response.json()) as { external?: { google?: boolean } };
		return settings.external?.google === true;
	} catch {
		return false;
	}
}

/** Only the codes the page can explain; everything else is generic. */
function codeFor(message: string): string {
	const text = message.toLowerCase();
	if (text.includes("invalid")) return "invalid_credentials";
	if (text.includes("confirm")) return "email_not_confirmed";
	if (text.includes("rate") || text.includes("too many")) return "rate_limit";
	return "invalid_credentials";
}

/** POST /auth/login - password grant, then home (or the ?next target). */
export async function signInAction(_previous: LoginState, formData: FormData): Promise<LoginState> {
	const next = safeReturnPath(String(formData.get("next") ?? ""));
	const email = String(formData.get("email") ?? "").trim();
	const password = String(formData.get("password") ?? "");
	if (!email || !password) return { error: "Enter your email and password." };

	if (!hostedMode()) return { error: "This build has no accounts (HOSTED_MODE is off)." };
	const supabase = await supabaseServer();
	if (!supabase) return { error: "Supabase is not configured." };

	const { error } = await supabase.auth.signInWithPassword({ email, password });
	if (error) {
		const back = new URLSearchParams({ next, error: codeFor(error.message) });
		redirect(`${LOGIN_PATH}?${back}`);
	}

	revalidatePath("/", "layout");
	redirect(next);
}

/** POST /auth/login with intent=google - the OAuth redirect. Hidden until
 * GOOGLE_ENABLED is on; the page only renders the button then. */
export async function googleSignInAction(formData: FormData): Promise<void> {
	const config = hostedConfig();
	if (!config) redirect(LOGIN_PATH);
	const next = safeReturnPath(String(formData.get("next") ?? ""));
	const supabase = await supabaseServer();
	if (!supabase) redirect(LOGIN_PATH);
	const redirectTo = new URL(`${config.origin}${CALLBACK_PATH}`);
	if (next !== "/") redirectTo.searchParams.set("next", next);
	const { data, error } = await supabase.auth.signInWithOAuth({
		provider: "google",
		options: { redirectTo: redirectTo.toString() },
	});
	if (error || !data.url) redirect(`${LOGIN_PATH}?error=oauth&next=${encodeURIComponent(next)}`);
	redirect(data.url);
}
