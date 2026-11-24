"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getAuth } from "@/src/server";
import { hostedConfig, hostedMode, LOGIN_PATH } from "@/src/core";

/**
 * Sign out. Better Auth clears the session cookie through the nextCookies
 * plugin; the redirected request is already anonymous as far as the Proxy.
 */
export async function signOutAction(): Promise<void> {
	if (hostedMode()) {
		try {
			await getAuth().api.signOut({ headers: await headers() });
		} catch {
			// An expired session is already signed out; proceed with the redirect.
		}
	}
	// Every rendered page carries an owner-derived theme, sidebar and boot
	// state: drop the whole client router cache, not one path.
	revalidatePath("/", "layout");
	// Redirect with the public origin so a proxy-hosted deployment does not
	// bounce to an internal address.
	const origin = hostedConfig()?.origin ?? "";
	redirect(`${origin}${LOGIN_PATH}`);
}
