import { NextResponse, type NextRequest } from "next/server";
import { hostedMode, LOGIN_PATH, safeReturnPath } from "@/src/core";

/**
 * GET /auth/callback - a compatibility redirect only. Better Auth completes
 * OAuth itself at /api/auth/callback/google and sets the session cookie on
 * THAT response, so there is no code exchange to do here. A stale email-link
 * callback lands on sign-in with an explainable error instead of a loop.
 */
export function GET(request: NextRequest) {
	const next = safeReturnPath(request.nextUrl.searchParams.get("next"));
	const login = new URL(LOGIN_PATH, request.url);
	login.searchParams.set("next", next);

	let response: Response;
	if (!hostedMode()) {
		login.searchParams.set("error", "hosted_off");
		response = NextResponse.redirect(login);
	} else {
		response = NextResponse.redirect(new URL(next, request.url));
	}

	const cacheHeaders = {
		"Cache-Control": "private, no-cache, no-store, must-revalidate, max-age=0",
		Expires: "0",
		Pragma: "no-cache",
	};
	for (const [key, value] of Object.entries(cacheHeaders)) response.headers.set(key, value);
	return response;
}
