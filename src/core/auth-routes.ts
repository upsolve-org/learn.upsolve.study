/**
 * Auth route vocabulary shared by the Proxy and the auth handlers. Pure: no
 * request, no cookies, so both sides and the tests can agree on what a
 * public path is and what a safe return path is.
 */

export const LOGIN_PATH = "/auth/login";
export const CALLBACK_PATH = "/auth/callback";
export const SIGNUP_PATH = "/auth/signup";
export const DENIED_PATH = "/auth/denied";

/** Better Auth's mount point. The Proxy must let it through unauthenticated:
 *  it IS the login/callback/oauth endpoint the session gate would otherwise
 *  redirect to itself. */
export const AUTH_API_PREFIX = "/api/auth";

/** True for the mount point itself and every endpoint beneath it. */
export function authApiPath(pathname: string): boolean {
	return pathname === AUTH_API_PREFIX || pathname.startsWith(`${AUTH_API_PREFIX}/`);
}

export function loginPath(pathname: string): boolean {
	return pathname === LOGIN_PATH || pathname === `${LOGIN_PATH}/`;
}

/** The request-an-account form: public like sign-in, but creates nothing. */
export function signupPath(pathname: string): boolean {
	return pathname === SIGNUP_PATH || pathname === `${SIGNUP_PATH}/`;
}

export function deniedPath(pathname: string): boolean {
	return pathname === DENIED_PATH || pathname === `${DENIED_PATH}/`;
}

export function signInCallbackPath(pathname: string): boolean {
	return pathname === CALLBACK_PATH;
}

/**
 * The post-login return target. Only a same-origin absolute path survives:
 * no scheme, no host, no protocol-relative `//host`, no backslash tricks
 * (`/\evil.com` becomes `//evil.com` in a browser).
 */
export function safeReturnPath(candidate: string | null | undefined, fallback = "/"): string {
	if (!candidate) return fallback;
	const raw = candidate.trim();
	if (!raw.startsWith("/") || raw.startsWith("//")) return fallback;
	if (raw.includes("\\") || raw.includes("\n") || raw.includes("\r")) return fallback;
	const target = new URL(raw, "http://local.invalid");
	if (target.origin !== "http://local.invalid") return fallback;
	return `${target.pathname}${target.search}${target.hash}`;
}

/**
 * The one streamed document endpoint, which opts out of the Proxy for every
 * method because Next's body clone truncates it (see proxy.ts). Same shapes
 * the matcher always accepted: exact path, optional trailing slash and
 * query, and a percent-encoded valid id.
 */
/** Plugin ids in practice are [a-z0-9-]; anything else only relaxes the
 * check, it never excuses a malformed escape. */
const DOCUMENT_ENDPOINT = /^\/api\/plugins\/[^/%]+\/documents\/markdown\/?$/;

/**
 * True when the path IS the streamed document endpoint. A malformed escape
 * is not excused: without a clean decode the route cannot name its plugin
 * reliably, so the Proxy handles it like any other API path.
 */
export function documentEndpointExempt(url: URL): boolean {
	if (DOCUMENT_ENDPOINT.test(url.pathname)) return true;
	try {
		return DOCUMENT_ENDPOINT.test(decodeURIComponent(url.pathname));
	} catch {
		return false;
	}
}

/**
 * The matcher source, byte-identical to `config.matcher` in proxy.ts. Kept here
 * because Next needs a literal to parse at build time; proxy.ts asserts the two
 * stay equal. Only `_next` build output is outside it — hosted mode must gate
 * pages too, so the runtime exemption is what narrows any endpoint.
 */
export const PROXY_MATCHER = /^\/(?!_next\/static|_next\/image|_next\/webpack-hmr).*$/;

/** Sign-in errors arrive as ?error=...; map the ones users can act on. */
export function loginErrorMessage(code: string | null | undefined): string | undefined {
	switch (code) {
		case undefined:
		case null:
		case "":
			return undefined;
		case "oauth":
			return "Google sign-in did not complete. Try again.";
		case "hosted_off":
			return "This build has no accounts (HOSTED_MODE is off).";
		case "invalid_credentials":
			return "That email or password is not right.";
		case "email_not_confirmed":
			return "Check your inbox and confirm the address first.";
		case "signup_disabled":
			return "Signups are closed on this deployment; ask for an account.";
		case "rate_limit":
			return "Too many attempts. Wait a moment and try again.";
		case "not_allowed":
			return "That account is not on the pilot list yet.";
		default:
			return "Sign-in failed. Try again.";
	}
}