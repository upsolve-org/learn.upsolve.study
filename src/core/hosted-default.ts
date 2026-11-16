/**
 * THE HOSTED DEFAULT MODEL (2026-11-16).
 *
 * Every learner gets the operator's OpenAI-compatible endpoint as a default, so
 * a new account can start a session with nothing configured. The API key stays
 * server-side: it is read from the environment and baked into the provider at
 * publication, never written into the learner's settings record and never sent
 * to the browser (the picker only learns `keyPresent: true`).
 *
 * This is a DEFAULT, not a pin. It fills only what the learner has not chosen
 * themselves, so a personal endpoint or key still wins.
 *
 * Off unless hosted mode is on AND all three variables are set, so desktop and
 * plain dev are unchanged.
 */
import { hostedMode } from "./hosted.ts";
import { normalizeBaseUrl } from "./settings.ts";

export interface HostedDefault {
	baseUrl: string;
	model: string;
	apiKey: string;
}

type Env = Record<string, string | undefined>;

/** The configured default, or undefined when incomplete or not hosted. */
export function hostedDefault(env: Env = process.env): HostedDefault | undefined {
	if (!hostedMode(env)) return undefined;
	const baseUrl = normalizeBaseUrl((env.HOSTED_DEFAULT_BASE_URL ?? "").trim());
	const model = (env.HOSTED_DEFAULT_MODEL ?? "").trim();
	const apiKey = (env.HOSTED_DEFAULT_API_KEY ?? "").trim();
	if (!baseUrl || !model || !apiKey) return undefined;
	return { baseUrl, model, apiKey };
}

/** True when this base URL is the operator's default. */
export function isHostedDefaultUrl(baseUrl: string | undefined, env: Env = process.env): boolean {
	const fallback = hostedDefault(env);
	return Boolean(fallback && baseUrl === fallback.baseUrl);
}