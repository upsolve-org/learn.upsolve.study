import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hostedConfigurationError, hostedConfig, hostedMode } from "../src/core/hosted.ts";
import { isOwnerId, ownerFromUnverified, unverifiedClaimsForTest } from "../src/core/owner.ts";
import { loginErrorMessage, loginPath, safeReturnPath, signInCallbackPath } from "../src/core/auth-routes.ts";

const ID = "9d0409ac-ee31-4944-8cc8-56ef5eb1bed5";
const sound = {
	HOSTED_MODE: "on",
	NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:8000/",
	NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_x",
};

describe("hosted mode", () => {
	it("is off unless explicitly switched", () => {
		for (const value of [undefined, "", "off", "no", "0", "false", " ", "onish"]) {
			assert.equal(hostedMode({ HOSTED_MODE: value }), false, String(value));
		}
		assert.equal(hostedMode({}), false);
		for (const value of ["on", "ON", " on ", "1", "true", "True"]) {
			assert.equal(hostedMode({ HOSTED_MODE: value }), true, value);
		}
	});

	it("fails closed naming EVERY missing variable, and stays silent when off", () => {
		assert.equal(hostedConfigurationError({}), null, "off: no requirement");
		const error = hostedConfigurationError({ HOSTED_MODE: "on" });
		assert.match(error ?? "", /NEXT_PUBLIC_SUPABASE_URL/);
		assert.match(error ?? "", /NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY/);
		assert.equal(hostedConfigurationError({ ...sound, NEXT_PUBLIC_SUPABASE_URL: "  " }), hostedConfigurationError({ ...sound, NEXT_PUBLIC_SUPABASE_URL: "" }), "blank counts as missing");
		assert.match(hostedConfigurationError({ ...sound, NEXT_PUBLIC_SUPABASE_URL: "" }) ?? "", /^HOSTED_MODE=on is missing NEXT_PUBLIC_SUPABASE_URL/);
	});

	it("trims the trailing slash off the URL and defaults the origin", () => {
		const config = hostedConfig(sound);
		assert.equal(config?.url, "http://127.0.0.1:8000");
		assert.equal(config?.origin, "http://localhost:3000");
		assert.equal(hostedConfig({ ...sound, APP_ORIGIN: "https://learn.upsolve.study/" })?.origin, "https://learn.upsolve.study");
		assert.equal(hostedConfig({}), null);
		assert.throws(() => hostedConfig({ HOSTED_MODE: "on" }), /missing/);
	});
});

describe("owner", () => {
	it("accepts only a UUID, canonicalised to lowercase", () => {
		assert.equal(isOwnerId(ID), true);
		assert.equal(isOwnerId(ID.toUpperCase()), false, "raw form must be lowercase");
		assert.equal(ownerFromUnverified(ID.toUpperCase()), ID);
		assert.equal(ownerFromUnverified("  " + ID + " "), ID);
		for (const bad of [undefined, null, 42, "", "abc", "../../etc", ID + "/x", `${ID}-`]) {
			assert.equal(ownerFromUnverified(bad), undefined, String(bad));
		}
	});

	it("never takes the owner from a foreign claim", () => {
		assert.equal(unverifiedClaimsForTest({ sub: ID, role: "authenticated" })?.sub, ID);
		assert.equal(unverifiedClaimsForTest({ sub: "../evil" }), undefined);
		assert.equal(unverifiedClaimsForTest({ sub: ID })?.role, "authenticated", "role defaults, never empty");
	});
});

describe("auth routes", () => {
	it("recognises exactly the public auth paths", () => {
		assert.equal(loginPath("/auth/login"), true);
		assert.equal(loginPath("/auth/login/"), true);
		assert.equal(loginPath("/auth/login/x"), false);
		assert.equal(signInCallbackPath("/auth/callback"), true);
		assert.equal(signInCallbackPath("/auth/callback/"), false);
	});

	it("keeps only same-origin absolute paths", () => {
		for (const [input, want] of [
			["/chat/abc", "/chat/abc"],
			["/chat/abc?x=1#y", "/chat/abc?x=1#y"],
			["/auth/login", "/auth/login"],
			[null, "/"],
			[undefined, "/"],
			["", "/"],
			["chat", "/"],
			["https://learn.upsolve.study/chat", "/"],
			["//evil.example/x", "/"],
			["/\\evil.example", "/"],
			[" /\n/evil", "/"],
		] as const) {
			assert.equal(safeReturnPath(input), want, String(input));
		}
		assert.equal(safeReturnPath("/x", "/fallback"), "/x");
	});

	it("explains the codes users can act on and hides the rest", () => {
		assert.equal(loginErrorMessage(undefined), undefined);
		assert.match(loginErrorMessage("invalid_credentials") ?? "", /not right/);
		assert.match(loginErrorMessage("signup_disabled") ?? "", /closed/);
		assert.equal(loginErrorMessage("something_new"), "Sign-in failed. Try again.");
	});
});