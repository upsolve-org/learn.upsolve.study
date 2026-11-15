import { createServerClient, parseCookieHeader } from "@supabase/ssr";
import { hostedConfig } from "./hosted.ts";
import { hostedFetch } from "./hosted-fetch.ts";
import { isOwnerId } from "./owner.ts";

/** Temporary single-account boundary until all stores are owner-scoped. */
export function pilotUserAllowed(user: { id: string; email?: string }, email = process.env.HOSTED_PILOT_EMAIL): boolean {
	return Boolean(email?.trim()) && isOwnerId(user.id) && user.email?.toLowerCase() === email!.trim().toLowerCase();
}

/** The upload exemption must enforce the same verified identity as Proxy. */
export async function hostedRequestRefusal(request: Request): Promise<Response | undefined> {
	const config = hostedConfig();
	if (!config) return;
	const cookies = parseCookieHeader(request.headers.get("cookie") ?? "");
	const client = createServerClient(config.url, config.publishableKey, {
		global: { fetch: hostedFetch(config.url) },
		cookies: { getAll: () => cookies, setAll: () => {} },
	});
	try {
		const { data, error } = await client.auth.getUser();
		if (!error && data.user && pilotUserAllowed(data.user)) return;
		return Response.json({ error: "Sign in with the invited account." }, { status: data.user ? 403 : 401, headers: { "Cache-Control": "no-store" } });
	} catch {
		return Response.json({ error: "Authentication is temporarily unavailable." }, { status: 503, headers: { "Cache-Control": "no-store" } });
	}
}
