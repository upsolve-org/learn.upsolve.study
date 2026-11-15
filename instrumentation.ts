/**
 * Boot gates. Both run before the server serves anything.
 *
 * Hosted mode fails closed: one error naming every missing Supabase
 * variable, rather than a server that starts and silently trusts the
 * network (src/core/hosted.ts). Off, the check is a no-op.
 *
 * Plugins use the documented per-server initialization hook. A plugin failure
 * must not prevent access to existing learning data or teaching/practice.
 */
export async function register() {
	if (process.env.NEXT_RUNTIME !== "nodejs") return;
	const { assertHostedConfiguration } = await import("./src/core/hosted.ts");
	assertHostedConfiguration();
	const { initializePlugins } = await import("./src/server/plugins.ts");
	try { await initializePlugins(); }
	catch (error) { console.error("[plugins] Initialization failed; plugin management will report the error:", error); }
}