import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { apiRequestRefusal } from "./src/server/desktop-access.ts";
import { hostedConfig } from "./src/core/hosted.ts";
import { deniedPath, documentEndpointExempt, loginPath, safeReturnPath, signInCallbackPath, signupPath } from "./src/core/auth-routes.ts";
import { cookieWrites } from "./src/core/hosted-cookies.ts";
import { hostedFetch } from "./src/core/hosted-fetch.ts";
import { admittedUser, hostedIdentity } from "./src/core/hosted-admission.ts";

/**
 * Deskstop/browser-API gate. Protects API methods, including SSE and
 * spending/settings routes. The one streamed document route enforces the
 * identical all-method request policy inside its handler, avoiding Next's
 * silently truncated Proxy body clone. No public callback or worker bypass:
 * legitimate self-HTTP still needs the capability.
 *
 * TENANCY: the API gate is the ONLY gate most routes ever see, so it must also
 * forward the verified owner. Without this every API call would run unscoped
 * and read the shared root while pages read the owner's.
 */
async function apiGate(request: NextRequest) {
	const refusal = apiRequestRefusal(request);
	if (refusal) {
		return NextResponse.json(
			{ error: refusal },
			{ status: 403, headers: { "Cache-Control": "no-store" } },
		);
	}
	const identity = await hostedIdentity(request);
	if ("refusal" in identity) return identity.refusal;
	return NextResponse.next({ request: { headers: ownerHeaders(request, identity.owner) } });
}

/**
 * The internal header carrying the VERIFIED owner id upstream. It is set here
 * from the GoTrue-verified user and never trusted from the client: the Proxy
 * overwrites it on every hosted request.
 */
const OWNER_HEADER = "x-lh-owner";

/**
 * Request headers with the verified owner set, or cleared when there is none.
 * A client-supplied value is always dropped first, so only the Proxy decides.
 */
function ownerHeaders(request: NextRequest, owner: string | undefined): Headers {
	const headers = new Headers(request.headers);
	headers.delete(OWNER_HEADER);
	if (owner) headers.set(OWNER_HEADER, owner.toLowerCase());
	return headers;
}

/**
 * Hosted mode: refresh the Supabase session cookies and keep signed-out
 * traffic out. Returns the response whose cookies carry the refresh.
 *
 * Private pages verify the session against GoTrue over the internal
 * transport. The verified id is forwarded as `x-lh-owner` so route handlers
 * and server components can enter the owner's storage scope
 * (src/core/owner-scope.ts) without another round trip.
 */
async function sessionGate(request: NextRequest, config: NonNullable<ReturnType<typeof hostedConfig>>) {
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
	const { pathname, search } = request.nextUrl;
	const publicPage = loginPath(pathname) || signupPath(pathname) || deniedPath(pathname) || signInCallbackPath(pathname) || isPublicAsset(pathname);
	const { data } = publicPage ? { data: { user: null } } : await supabase.auth.getUser();

	// Built only now, so a refresh is already in the headers Next copies on.
	const admitted = Boolean(data.user && admittedUser(data.user));
	const upstream = NextResponse.next({ request: { headers: ownerHeaders(request, admitted ? data.user!.id : undefined) } });
	if (admitted || publicPage) {
		return jar.landOn(upstream, upstream);
	}
	// Signed in but not admitted: explain rather than loop back to sign-in.
	if (data.user) return jar.landOn(upstream, NextResponse.redirect(new URL("/auth/denied", request.url)));
	const target = new URL("/auth/login", request.url);
	const back = safeReturnPath(`${pathname}${search}`);
	if (back !== "/") target.searchParams.set("next", back);
	return jar.landOn(upstream, NextResponse.redirect(target));
}

/** Files under /public and the manifest family: no session needed. */
function isPublicAsset(pathname: string): boolean {
	if (/\.(?:png|jpe?g|gif|svg|webp|ico|css|js|map|woff2?|ttf|otf|json|mjs)$/i.test(pathname)) return true;
	return /^\/(?:favicon\.ico|manifest\.webmanifest|sw\.js|logo-mark\.png)$/.test(pathname);
}

export async function proxy(request: NextRequest) {
	const { pathname } = request.nextUrl;
	const hosted = hostedConfig();

	// The streamed document endpoint opts out for every method in every
	// mode: Next's Proxy body clone truncates it, and the route enforces
	// the identical request policy inside its own handler.
	if (documentEndpointExempt(request.nextUrl)) return NextResponse.next();

	if (hosted && (pathname === "/api" || pathname.startsWith("/api/"))) {
		// The auth callback exchanges the code itself; everything else is
		// an API call and keeps the browser-API gate.
		if (signInCallbackPath(pathname)) return NextResponse.next();
		return apiGate(request);
	}
	if (hosted) return sessionGate(request, hosted);
	return apiGate(request);
}

export const config = {
	// Everything except static build output. The desktop/browser gate still
	// narrows itself to /api; hosted mode adds the page gate.
	matcher: ["/((?!_next/static|_next/image|_next/webpack-hmr).*)"],
};
