/**
 * Tenant key for PostgreSQL rows. The FS adapter resolves owner scope through
 * config.ownerPaths() at call time; the Postgres adapter resolves it through
 * this function at call time for exactly the same reason (the owner is
 * request state carried by AsyncLocalStorage, not an object identity).
 *
 * Unscoped work (desktop, plain dev, operator jobs) uses a single sentinel
 * so every row still has a non-null owner_id and the primary keys stay valid.
 */

import { currentOwnerId } from "../../core/owner-scope.ts";

export const LOCAL_OWNER = "__local__";

export function pgOwner(): string {
	return currentOwnerId() ?? LOCAL_OWNER;
}
