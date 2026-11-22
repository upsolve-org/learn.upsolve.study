import { getClaudeBinary } from "../agent/claude-code/binary.ts";
import { cachedSettings } from "./stores.ts";

/** Fresh admission state from the per-owner settings cache, not a
 *  process-wide toggle cache. Existing runs retain their engines; only new
 *  chat/job/extraction/compaction admissions consult it. The admission gates
 *  are synchronous seams, so they read the cache rather than awaiting an
 *  async store adapter. */
export function claudeCodeEnabled(): boolean {
	return cachedSettings()?.claudeCode?.enabled === true;
}

/** Installation/opt-in availability only, never authenticated readiness. */
export function claudeCodeAvailable(): boolean {
	return claudeCodeEnabled() && getClaudeBinary() !== null;
}
