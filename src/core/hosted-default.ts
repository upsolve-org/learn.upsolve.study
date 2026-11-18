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
	/** Token limits for the default model. REQUIRED in practice: without them
	 *  the model falls back to the compiled 8192/4096 custom-endpoint defaults,
	 *  and a 16k compaction reserve leaves almost no output budget — replies
	 *  get clamped to a token or two. */
	contextWindow: number;
	maxTokens: number;
}

type Env = Record<string, string | undefined>;

/** Compiled limits for the hosted default. Generous on purpose: the gateway
 *  is the operator's own and the failure mode of a too-small window is silent
 *  truncation, not an error. */
export const HOSTED_DEFAULT_CONTEXT_WINDOW = 1_000_000;
export const HOSTED_DEFAULT_MAX_TOKENS = 1_000_000;

function positiveInt(raw: string | undefined, fallback: number): number {
	const value = Number((raw ?? "").trim());
	return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/** The configured default, or undefined when incomplete or not hosted.<|place_holder_mm_span_0442|> */
export function hostedDefault(env: Env = process.env): HostedDefault | undefined {
	if (!hostedMode(env)) return undefined;
	const baseUrl = normalizeBaseUrl((env.HOSTED_DEFAULT_BASE_URL ?? "").trim());
	const model = (env.HOSTED_DEFAULT_MODEL ?? "").trim();
	const apiKey = (env.HOSTED_DEFAULT_API_KEY ?? "").trim();
	if (!baseUrl || !model || !apiKey) return undefined;
	return {
		baseUrl, model, apiKey,
		contextWindow: positiveInt(env.HOSTED_DEFAULT_CONTEXT_WINDOW, HOSTED_DEFAULT_CONTEXT_WINDOW),
		maxTokens: positiveInt(env.HOSTED_DEFAULT_MAX_TOKENS, HOSTED_DEFAULT_MAX_TOKENS),
	};
}

/** True when this base URL is the operator's default. */
export function isHostedDefaultUrl(baseUrl: string | undefined, env: Env = process.env): boolean {
	const fallback = hostedDefault(env);
	return Boolean(fallback && baseUrl === fallback.baseUrl);
}
