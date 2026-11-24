import { NextResponse, type NextRequest } from "next/server";
import { apiRequestRefusal } from "./src/server/desktop-access.ts";
import { hostedConfig } from "./src/core/hosted.ts";
import { authApiPath, deniedPath, documentEndpointExempt, loginPath, safeReturnPath, signInCallbackPath, signupPath } from "./src/core/auth-routes.ts";
import { admittedUser, isOperator } from "./src/core/hosted-admission.ts";
import { getSessionUser, hostedIdentityFromHeaders } from "./src/server/auth.ts";

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
	const identity = await hostedIdentityFromHeaders(request.headers);
	if ("refusal" in identity) return identity.refusal;
	return NextResponse.next({ request: { headers: ownerHeaders(request, identity.owner, identity.operator) } });
}

/**
 * The internal header carrying the VERIFIED owner id upstream. It is set here
 * from the authenticated user and never trusted from the client: the Proxy
 * overwrites it on every request.
 */
const OWNER_HEADER = "x-lh-owner";
/** Internal capability header: "1" ONLY for the operator. Never client-set. */
const OPERATOR_HEADER = "x-lh-operator";

/**
 * Request headers with the verified owner/operator set, or cleared when there
 * is none. A client-supplied value is always dropped FIRST, so only the Proxy
 * decides — a learner cannot grant itself operator access by sending the
 * header (Next deletes any header not in this forwarded set downstream).
 */
function ownerHeaders(request: NextRequest, owner: string | undefined, operator = false): Headers {
	const headers = new Headers(request.headers);
	headers.delete(OWNER_HEADER);
	headers.delete(OPERATOR_HEADER);
	if (owner) headers.set(OWNER_HEADER, owner.toLowerCase());
	if (operator) headers.set(OPERATOR_HEADER, "1");
	return headers;
}

/**
 * Hosted mode: keep signed-out traffic out of private pages. Session cookies
 * are Better Auth's; getSessionUser resolves them through the same server
 * seam the route handlers use. The verified id is forwarded as `x-lh-owner`
 * so route handlers and server components can enter the owner's storage scope
 * (src/core/owner-scope.ts) without a second lookup.
 */
async function sessionGate(request: NextRequest) {
	const { pathname, search } = request.nextUrl;
	const publicPage = loginPath(pathname) || signupPath(pathname) || deniedPath(pathname) || signInCallbackPath(pathname) || isPublicAsset(pathname);
	const user = publicPage ? null : await getSessionUser(request.headers);

	// Built only now, so the verified identity is already in the headers Next copies on.
	const admitted = Boolean(user && admittedUser(user));
	const upstream = NextResponse.next({ request: { headers: ownerHeaders(request, admitted ? user!.id : undefined, admitted && isOperator(user?.email)) } });
	if (admitted || publicPage) return upstream;
	// Signed in but not admitted: explain rather than loop back to sign-in.
	if (user) return NextResponse.redirect(new URL("/auth/denied", request.url));
	const target = new URL("/auth/login", request.url);
	const back = safeReturnPath(`${pathname}${search}`);
	if (back !== "/") target.searchParams.set("next", back);
	return NextResponse.redirect(target);
}

/** Files under /public and the manifest family: no session needed. */
function isPublicAsset(pathname: string): boolean {
	if (/\.(?:png|jpe?g|gif|svg|webp|ico|css|js|map|woff2?|ttf|otf|json|mjs)$/i.test(pathname)) return true;
	return /^\/(?:favicon\.ico|manifest\.webmanifest|sw\.js|logo-mark\.png)$/.test(pathname);
}

export async function proxy(request: NextRequest) {
	const { pathname } = request.nextUrl;
	// Fail closed on a misconfigured hosted deployment before any gate runs
	// (same boot check the instrumentation uses).
	const hosted = hostedConfig();

	// The streamed document endpoint opts out for every method in every
	// mode: Next's Proxy body clone truncates it, and the route enforces
	// the identical request policy inside its own handler.
	if (documentEndpointExempt(request.nextUrl)) return NextResponse.next();

	// Better Auth owns /api/auth/*: login, sign-out, sessions and OAuth
	// callbacks must work while signed out. Still strip client-supplied
	// owner/operator headers before handing the request to the handler.
	if (authApiPath(pathname)) {
		return NextResponse.next({ request: { headers: ownerHeaders(request, undefined, false) } });
	}

	if (hosted && (pathname === "/api" || pathname.startsWith("/api/"))) {
		// The page callback only redirects; unchanged from the previous gate.
		if (signInCallbackPath(pathname)) return NextResponse.next();
		return apiGate(request);
	}
	if (hosted) return sessionGate(request);
	return apiGate(request);
}

export const config = {
	// Everything except static build output. The desktop/browser gate still
	// narrows itself to /api; hosted mode adds the page gate.
	matcher: ["/((?!_next/static|_next/image|_next/webpack-hmr).*)"],
};
