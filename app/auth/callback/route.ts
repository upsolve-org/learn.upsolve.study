import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { hostedConfig, LOGIN_PATH, safeReturnPath } from "@/src/core";
import { hostedFetch, cookieWrites } from "@/src/server";

/**
 * GET /auth/callback - the PKCE code exchange for email links and Google.
 *
 * Cookies can only be written on a response here, so the redirect response
 * IS the carrier: @supabase/ssr hands the session cookies to setAll and
 * they are attached before the browser follows the Location.
 *
 * A missing code or a failed exchange lands on /auth/login?error=... with
 * the same generic message Supabase uses (no oracle for which half failed).
 */
export async function GET(request: NextRequest) {
	const config = hostedConfig();
	const login = new URL(LOGIN_PATH, request.url);
	const next = safeReturnPath(request.nextUrl.searchParams.get("next"));
	login.searchParams.set("next", next);

	if (!config) {
		login.searchParams.set("error", "hosted_off");
		return NextResponse.redirect(login);
	}

	const jar = cookieWrites();
	const supabase = createServerClient(config.url, config.publishableKey, {
		global: { fetch: hostedFetch(config.url) },
		cookies: {
			getAll: () => request.cookies.getAll(),
			setAll: (list) => {
				for (const { name, value } of list) request.cookies.set(name, value);
				jar.setAll(list);
			},
		},
	});

	const code = request.nextUrl.searchParams.get("code");
	const response =
		code === null
			? NextResponse.redirect(withError(login))
			: await (async () => {
					const { error } = await supabase.auth.exchangeCodeForSession(code);
					return error ? NextResponse.redirect(withError(login)) : NextResponse.redirect(new URL(next, request.url));
				})();

	const cacheHeaders = {
		"Cache-Control": "private, no-cache, no-store, must-revalidate, max-age=0",
		Expires: "0",
		Pragma: "no-cache",
	};
	for (const [key, value] of Object.entries(cacheHeaders)) response.headers.set(key, value);
	return jar.landOn(response, response);
}

function withError(url: URL): URL {
	url.searchParams.set("error", "oauth");
	return url;
}
