/**
 * HOSTED_MODE: the one server-side switch that turns this build into the
 * multi-user web app (docs/supabase-webapp-plan.md, step 1). `off` is the
 * desktop and local-work behaviour, byte for byte. The switch is an env
 * value and never a request header: a client cannot turn the gate off.
 *
 * `on` has a hard prerequisite - Supabase - and fails closed at boot with
 * ONE error naming everything missing, rather than degrading to the
 * loopback trust of browser-only mode (src/server/desktop-access.ts).
 *
 * The Supabase URL and publishable key are NEXT_PUBLIC_*, because the
 * browser client needs them too. The database DSN is server-only.
 */
export type HostedConfig = {
	url: string;
	publishableKey: string;
	dbUrl: string;
	/** Public app origin, for redirects (APP_ORIGIN). */
	origin: string;
};

type Env = Record<string, string | undefined>;

/** Read only through this: "on"/"1"/"true" enable hosted mode. */
export function hostedMode(env: Env = process.env): boolean {
	const raw = (env.HOSTED_MODE ?? "").trim().toLowerCase();
	return raw === "on" || raw === "1" || raw === "true";
}

const REQUIRED = [
	"NEXT_PUBLIC_SUPABASE_URL",
	"NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
	"SUPABASE_DB_URL",
] as const;

/** One message listing every missing name, or null when hosted mode is sound. */
export function hostedConfigurationError(env: Env = process.env): string | null {
	if (!hostedMode(env)) return null;
	const missing = REQUIRED.filter((name) => !(env[name] ?? "").trim());
	if (missing.length > 0) {
		return `HOSTED_MODE=on is missing ${missing.join(", ")}. Set them (see docs/supabase-webapp-plan.md) or unset HOSTED_MODE.`;
	}
	return null;
}

/** Boot gate (instrumentation.ts). Throws the single configuration error. */
export function assertHostedConfiguration(env: Env = process.env): void {
	const error = hostedConfigurationError(env);
	if (error) throw new Error(error);
}

/** The configuration, or null when hosted mode is off. */
export function hostedConfig(env: Env = process.env): HostedConfig | null {
	if (!hostedMode(env)) return null;
	const error = hostedConfigurationError(env);
	if (error) throw new Error(error);
	return {
		url: env.NEXT_PUBLIC_SUPABASE_URL!.trim().replace(/\/+$/, ""),
		publishableKey: env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!.trim(),
		dbUrl: env.SUPABASE_DB_URL!.trim(),
		origin: (env.APP_ORIGIN ?? "http://localhost:3000").trim().replace(/\/+$/, ""),
	};
}