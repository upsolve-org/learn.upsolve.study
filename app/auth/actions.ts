"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { supabaseServer } from "@/src/server";
import { hostedConfig, LOGIN_PATH } from "@/src/core";

/**
 * Sign out. Cookies are cleared by the client before the redirect (the
 * render-phase write above is only best-effort), so the next request is
 * already anonymous as far as the Proxy is concerned.
 */
export async function signOutAction(): Promise<void> {
	const supabase = await supabaseServer();
	if (supabase) await supabase.auth.signOut();
	// Every rendered page carries an owner-derived theme, sidebar and boot
	// state: drop the whole client router cache, not one path.
	revalidatePath("/", "layout");
	// Redirect with the public origin so a proxy-hosted deployment does not
	// bounce to an internal address.
	redirect(`${hostedConfig()?.origin ?? ""}${LOGIN_PATH}`);
}