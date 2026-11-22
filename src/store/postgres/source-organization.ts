/**
 * SourceOrganizationStore — the PostgreSQL adapter for the per-owner
 * folder/placement map. parseSourceOrganization is the single validator for
 * both backends; a corrupt row throws instead of overwriting good data.
 */

import type { Pool } from "pg";
import type { SourceOrganizationStore } from "../../core/ports.ts";
import { emptySourceOrganization, parseSourceOrganization } from "../../core/source-organization.ts";
import { emit } from "../../core/events.ts";
import { pgOwner } from "./owner.ts";

export function createPostgresSourceOrganizationStore(pool: Pool): SourceOrganizationStore {
	return {
		async read() {
			const { rows } = await pool.query<{ state: unknown }>(
				"SELECT state FROM source_organization WHERE owner_id = $1",
				[pgOwner()],
			);
			if (!rows[0]) return emptySourceOrganization();
			let raw = rows[0].state;
			if (typeof raw === "string") {
				try { raw = JSON.parse(raw); } catch { /* parseSourceOrganization refuses it */ }
			}
			return parseSourceOrganization(raw);
		},

		async write(state) {
			const valid = parseSourceOrganization(state);
			await pool.query(
				`INSERT INTO source_organization (owner_id, state, updated_at)
				 VALUES ($1, $2::jsonb, NOW())
				 ON CONFLICT (owner_id) DO UPDATE SET state = EXCLUDED.state, updated_at = NOW()`,
				[pgOwner(), JSON.stringify(valid)],
			);
			emit("sources-changed", {});
		},
	};
}
