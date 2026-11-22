/**
 * The PostgreSQL adapter set — wired once by src/server/stores.ts (and by
 * scripts/worker.ts for background jobs). Every adapter takes the shared
 * Pool; none of them imports src/server or opens a connection of its own.
 */

import type { Pool } from "pg";
import type { BlobStore } from "../../core/ports.ts";
import { createPostgresChatStore } from "./chats.ts";
import { createPostgresGraphStore } from "./graph.ts";
import { createPostgresJobStore } from "./jobs.ts";
import { createPostgresSettingsStore } from "./settings.ts";
import { createPostgresThemeStore } from "./themes.ts";
import { createPostgresSourceOrganizationStore } from "./source-organization.ts";
import { createPostgresPromptOverrideStore } from "./prompt-overrides.ts";

export function createPostgresStores(
	pool: Pool,
	options?: { blobStore?: BlobStore; offloadSnapshots?: boolean },
) {
	return {
		chatStore: createPostgresChatStore(pool, options),
		graphStore: createPostgresGraphStore(pool),
		sourceOrganizationStore: createPostgresSourceOrganizationStore(pool),
		jobStore: createPostgresJobStore(pool),
		settingsStore: createPostgresSettingsStore(pool),
		themeStore: createPostgresThemeStore(pool),
		promptOverrides: createPostgresPromptOverrideStore(pool),
	};
}

export {
	createPostgresChatStore,
	createPostgresGraphStore,
	createPostgresJobStore,
	createPostgresSettingsStore,
	createPostgresThemeStore,
	createPostgresSourceOrganizationStore,
	createPostgresPromptOverrideStore,
};
