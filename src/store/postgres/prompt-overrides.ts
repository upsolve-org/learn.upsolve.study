/**
 * PromptOverrideStore — the PostgreSQL adapter for per-segment system prompt
 * overrides. The fs adapter mirrors the source layout under a directory;
 * here each POSIX-relative segment path is a row key. The same core path
 * grammar (isValidSegmentPath) rejects traversal and non-.md paths.
 */

import type { Pool } from "pg";
import type { PromptOverrideStore } from "../../core/ports.ts";
import { isValidSegmentPath } from "../../core/prompt-segments.ts";
import { pgOwner } from "./owner.ts";

export function createPostgresPromptOverrideStore(pool: Pool): PromptOverrideStore {
	return {
		async listOverrides() {
			const { rows } = await pool.query<{ segment_path: string }>(
				"SELECT segment_path FROM prompt_overrides WHERE owner_id = $1 ORDER BY segment_path ASC",
				[pgOwner()],
			);
			return rows
				.map((row) => row.segment_path)
				.filter((path) => isValidSegmentPath(path))
				.sort();
		},

		async readOverride(segmentPath) {
			if (!isValidSegmentPath(segmentPath)) return null;
			const { rows } = await pool.query<{ content: string }>(
				"SELECT content FROM prompt_overrides WHERE owner_id = $1 AND segment_path = $2",
				[pgOwner(), segmentPath],
			);
			return rows[0]?.content ?? null;
		},

		async writeOverride(segmentPath, text) {
			if (!isValidSegmentPath(segmentPath)) return;
			await pool.query(
				`INSERT INTO prompt_overrides (owner_id, segment_path, content, updated_at)
				 VALUES ($1, $2, $3, NOW())
				 ON CONFLICT (owner_id, segment_path)
				 DO UPDATE SET content = EXCLUDED.content, updated_at = NOW()`,
				[pgOwner(), segmentPath, text],
			);
		},

		async deleteOverride(segmentPath) {
			if (!isValidSegmentPath(segmentPath)) return;
			await pool.query(
				"DELETE FROM prompt_overrides WHERE owner_id = $1 AND segment_path = $2",
				[pgOwner(), segmentPath],
			);
		},
	};
}
