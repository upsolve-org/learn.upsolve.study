/**
 * ThemeStore — the PostgreSQL adapter for imported custom themes.
 * Re-validates on every read (a hand-edited row is skipped, never thrown)
 * and keeps the fs adapter's id grammar so a crafted id cannot escape its
 * namespace.
 */

import type { Pool } from "pg";
import type { ThemeStore } from "../../core/ports.ts";
import { isBuiltinThemeId, isThemeId, sanitizeThemeFile, type Theme, type ThemeFile } from "../../core/themes.ts";
import { pgOwner } from "./owner.ts";

function parseTheme(value: unknown, id: string): Theme | null {
	let raw: unknown = value;
	if (typeof raw === "string") {
		try { raw = JSON.parse(raw); } catch { return null; }
	}
	const clean = sanitizeThemeFile(raw);
	return clean ? { ...clean, id, builtin: false } : null;
}

export function createPostgresThemeStore(pool: Pool): ThemeStore {
	return {
		async listThemes() {
			const { rows } = await pool.query<{ id: string; theme: unknown }>(
				"SELECT id, theme FROM user_themes WHERE owner_id = $1",
				[pgOwner()],
			);
			return rows
				.map((row) => parseTheme(row.theme, row.id))
				.filter((theme): theme is Theme => theme !== null)
				.sort((a, b) => a.id.localeCompare(b.id));
		},

		async readTheme(id) {
			if (!isThemeId(id) || isBuiltinThemeId(id)) return null;
			const { rows } = await pool.query<{ theme: unknown }>(
				"SELECT theme FROM user_themes WHERE owner_id = $1 AND id = $2",
				[pgOwner(), id],
			);
			return rows[0] ? parseTheme(rows[0].theme, id) : null;
		},

		async writeTheme(id, theme: ThemeFile) {
			if (!isThemeId(id) || isBuiltinThemeId(id)) throw new Error(`Invalid custom theme id "${id}"`);
			const file: ThemeFile = { name: theme.name, mode: theme.mode, colors: theme.colors };
			await pool.query(
				`INSERT INTO user_themes (owner_id, id, theme, updated_at)
				 VALUES ($1, $2, $3::jsonb, NOW())
				 ON CONFLICT (owner_id, id) DO UPDATE SET theme = EXCLUDED.theme, updated_at = NOW()`,
				[pgOwner(), id, JSON.stringify(file)],
			);
		},

		async deleteTheme(id) {
			if (!isThemeId(id) || isBuiltinThemeId(id)) return;
			await pool.query(
				"DELETE FROM user_themes WHERE owner_id = $1 AND id = $2",
				[pgOwner(), id],
			);
		},
	};
}
