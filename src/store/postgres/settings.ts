/**
 * SettingsStore — the PostgreSQL adapter for THE user settings record.
 * Sanitization is owned by core/settings.ts in both directions, exactly as
 * in src/store/settings.ts: no value that would silently shift a knob can
 * reach a caller or the database.
 */

import type { Pool } from "pg";
import { sanitizeUserSettings, type UserSettings } from "../../core/settings.ts";
import type { SettingsStore } from "../../core/ports.ts";
import { pgOwner } from "./owner.ts";

export function createPostgresSettingsStore(pool: Pool): SettingsStore {
	return {
		async readSettings() {
			const { rows } = await pool.query<{ settings: unknown }>(
				"SELECT settings FROM user_settings WHERE owner_id = $1",
				[pgOwner()],
			);
			if (!rows[0]) return null; // first boot — all factory defaults
			return sanitizeUserSettings(rows[0].settings);
		},

		async writeSettings(settings: UserSettings) {
			const clean = sanitizeUserSettings(settings);
			if (!clean) throw new Error("settings record must be a JSON object");
			await pool.query(
				`INSERT INTO user_settings (owner_id, settings, updated_at)
				 VALUES ($1, $2::jsonb, NOW())
				 ON CONFLICT (owner_id) DO UPDATE SET settings = EXCLUDED.settings, updated_at = NOW()`,
				[pgOwner(), JSON.stringify(clean)],
			);
		},
	};
}
