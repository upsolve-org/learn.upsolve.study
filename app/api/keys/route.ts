/**
 * GET /api/keys — the auth page's key list (auth-keys wave, 2026-09-19;
 * providers added by the provider-keys interlude same wave).
 *
 * Every curated key (present or not) plus unknown file vars surfaced as
 * generic rows — ABSENT provider keys deliberately do NOT spam status
 * rows; the provider dropdown is the discovery surface. `providers`
 * carries it: {id, envVar, label} for every pi-ai plain-key provider,
 * derived from pi-ai's own provider→env-var table (no-drift pin in
 * tests/auth-provider-keys.test.ts) — the settings UI reads it optionally
 * with a graceful fallback.
 *
 * Masked only — last 4 + length for ordinary keys; custom keys are fully
 * redacted at every length (no credential suffix). PLAINTEXT NEVER LEAVES THE STORE THROUGH
 * THIS API (owner decision). `source` tells the page whether the live
 * value comes from the environment (dev .env.local / launch env) or the
 * file, and `shadowedByEnv` explains why a saved key is not the live one
 * (env always wins).
 */
import { hostedMode } from "@/src/core";
import { keyStatuses, providerKeyList, ownerScoped, isOperatorRequest } from "@/src/server";

export const dynamic = "force-dynamic";

async function GETHandler(_request?: Request) {
	// Hosted learners must not see the operator's key inventory. Return the
	// empty SHAPE so the settings UI still renders normally; an empty list is
	// indistinguishable from "no keys configured" to a non-operator.
	if (hostedMode() && !isOperatorRequest(_request)) {
		return Response.json({ keys: [], providers: [] }, { headers: { "Cache-Control": "no-store" } });
	}
	return Response.json({ keys: keyStatuses(), providers: providerKeyList() });
}

// Tenancy: the body runs inside the caller's owner scope.
export const GET = ownerScoped(GETHandler);
