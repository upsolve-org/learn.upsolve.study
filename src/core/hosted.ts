/**
 * HOSTED_MODE: the one server-side switch that turns this build into the
 * multi-user web app (docs/supabase-webapp-plan.md, step 1). `off` is the
 * desktop and local-work behaviour, byte for byte. The switch is an env
 * value and never a request header: a client cannot turn the gate off.
 *
 * `on` has two hard prerequisites - DATABASE_URL and BETTER_AUTH_SECRET -
 * and fails closed at boot with ONE error naming everything missing, rather
 * than degrading to the loopback trust of browser-only mode
 * (src/server/desktop-access.ts).
 *
 * Both prerequisites are server-only. The browser never sees a database URL
 * or the auth secret; Google sign-in availability is a boolean derived here
 * from the presence of the provider credentials.
 */
export type HostedConfig = {
	databaseUrl: string;
	secret: string;
	/** Public app origin, for redirects (APP_ORIGIN). */
	origin: string;
	/** Show the Google button only when both provider credentials exist. */
	googleEnabled: boolean;
};

type Env = Record<string, string | undefined>;

/** Read only through this: "on"/"1"/"true" enable hosted mode. */
export function hostedMode(env: Env = process.env): boolean {
	const raw = (env.HOSTED_MODE ?? "").trim().toLowerCase();
	return raw === "on" || raw === "1" || raw === "true";
}

const REQUIRED = ["DATABASE_URL", "BETTER_AUTH_SECRET"] as const;

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
		databaseUrl: env.DATABASE_URL!.trim(),
		secret: env.BETTER_AUTH_SECRET!.trim(),
		origin: (env.APP_ORIGIN ?? "http://localhost:3000").trim().replace(/\/+$/, ""),
		googleEnabled: Boolean(env.GOOGLE_CLIENT_ID?.trim() && env.GOOGLE_CLIENT_SECRET?.trim()),
	};
}
