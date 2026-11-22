/**
 * Boot gates. Both run before the server serves anything.
 *
 * Hosted mode fails closed: one error naming every missing database/auth
 * variable, rather than a server that starts and silently trusts the
 * network (src/core/hosted.ts). Off, the check is a no-op.
 *
 * Plugins use the documented per-server initialization hook. A plugin failure
 * must not prevent access to existing learning data or teaching/practice.
 */
export async function register() {
	if (process.env.NEXT_RUNTIME !== "nodejs") return;
	const { assertHostedConfiguration, hostedMode } = await import("./src/core/hosted.ts");
	assertHostedConfiguration();

	// PR 5: swap the storage ports onto PostgreSQL BEFORE anything boots that
	// might read through them (plugins, routes, background workers). A DB that
	// is briefly unreachable is not fatal in local/dev mode — we keep the fs
	// adapters and say so. In hosted mode we fail closed: serving requests
	// against the wrong backend would be worse than not starting.
	const { hasDatabaseUrl, getPgPool, runMigrations } = await import("./src/server/db.ts");
	const { postgresStorageEnabled, configureStores } = await import("./src/server/stores.ts");
	if (postgresStorageEnabled() && hasDatabaseUrl()) {
		try {
			const pool = getPgPool();
			await runMigrations(pool);
			const { createPostgresStores } = await import("./src/store/postgres/index.ts");
			const { s3BlobConfigured, createS3BlobStore } = await import("./src/store/blobs-s3.ts");
			const s3 = s3BlobConfigured() ? createS3BlobStore() : undefined;
			configureStores({
				...createPostgresStores(pool, s3 ? { blobStore: s3, offloadSnapshots: true } : undefined),
				...(s3 ? { blobStore: s3 } : {}),
			});
			const { startPgEventsBridge, setJobDeliveryHandler } = await import("./src/server/pg-events.ts");
			startPgEventsBridge();
			// Sub-agent jobs run in the standalone worker (scripts/worker.ts):
			// this process enqueues them, asks the queue whether a job is still
			// running elsewhere (stale-job sweep), and performs the delivery
			// when the worker announces a finished job.
			const { startJobQueue, subagentJobPending } = await import("./src/server/pg-queue.ts");
			const { resumeChatDelivery, setRemoteJobLiveness } = await import("./src/server/jobs.ts");
			const { withOwner } = await import("./src/server/stores.ts");
			await startJobQueue();
			setRemoteJobLiveness(subagentJobPending);
			setJobDeliveryHandler(({ owner, chatId }) => {
				void withOwner(owner, () => resumeChatDelivery(chatId)).catch((error: unknown) => {
					console.error(`[chat ${chatId}] worker job delivery failed (the sweep will retry):`, error);
				});
			});
			console.info("[postgres] storage backend active; SSE bridge listening; sub-agent jobs dispatched to the worker");
		} catch (error) {
			if (hostedMode()) throw error;
			console.warn("[postgres] storage startup failed; continuing with filesystem stores:", error);
		}
	}

	const { initializePlugins } = await import("./src/server/plugins.ts");
	try { await initializePlugins(); }
	catch (error) { console.error("[plugins] Initialization failed; plugin management will report the error:", error); }
}