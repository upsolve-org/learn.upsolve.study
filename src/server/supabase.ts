/**
 * Request-scoped Supabase clients over @supabase/ssr cookie sessions.
 *
 * Server components, route handlers and Server Actions each build their own
 * client: never share one across requests, its session store is the current
 * request's cookies. Only the Proxy and route handlers may WRITE cookies;
 * elsewhere setAll is a no-op (the Proxy refreshes, so a read-only client is
 * still current).
 *
 * Supabase is only reached when HOSTED_MODE is on. Off, every accessor
 * returns null and callers fall back to the desktop path.
 */
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { hostedConfig } from "../core/hosted.ts";
import { isOwnerId } from "../core/owner.ts";
import { hostedFetch } from "../core/hosted-fetch.ts";
import { pilotUserAllowed } from "../core/hosted-admission.ts";

export type SupabaseServer = SupabaseClient;

async function build(writable: boolean): Promise<SupabaseServer | null> {
	const config = hostedConfig();
	if (!config) return null;
	const store = await cookies();
	return createServerClient(config.url, config.publishableKey, {
		global: { fetch: hostedFetch(config.url) },
		cookies: {
			getAll: () => store.getAll(),
			setAll: (list) => {
				if (!writable) return;
				// Read-only contexts throw if called while rendering; a
				// refresh during a render is picked up by the next request.
				try {
					for (const { name, value, options } of list) store.set(name, value, options as never);
				} catch {
					// ignore: render-phase write
				}
			},
		},
	});
}

/** Server components, pages, Server Actions. */
export function supabaseServer(): Promise<SupabaseServer | null> {
	return build(true);
}

/** Route handlers, which may also set cookies. */
export function supabaseRoute(): Promise<SupabaseServer | null> {
	return build(true);
}

/** The signed-in account id, or undefined. Server-verified: getUser() round
 * trips to GoTrue, so a revoked account stops passing immediately. */
export async function currentOwner(): Promise<string | undefined> {
	const supabase = await supabaseServer();
	if (!supabase) return undefined;
	const { data, error } = await supabase.auth.getUser();
	if (error || !data.user || !pilotUserAllowed(data.user)) return undefined;
	const id = data.user.id.toLowerCase();
	return isOwnerId(id) ? id : undefined;
}
