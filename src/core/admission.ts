/**
 * ADMISSION VOCABULARY — the pure, browser-safe half (tenancy wave,
 * 2026-11-16). No filesystem, no config: the shell imports this through the
 * core barrel, while the file-backed helpers live in hosted-admission.ts
 * behind the server barrel.
 */

export interface SignupRequest {
	email: string;
	requestedAt: string;
}

export type SignupOutcome = "queued" | "already-pending" | "already-admitted";

/** Addresses are compared case-insensitively; stored lowercase. */
export function normalizeEmail(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const email = value.trim().toLowerCase();
	// Deliberately loose: GoTrue is the real validator, this only rejects
	// obvious junk before it reaches the queue.
	if (email.length < 3 || email.length > 254) return undefined;
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return undefined;
	return email;
}

/** The operator: the only account that may open /admin. */
export function isOperator(email: string | undefined, env: Record<string, string | undefined> = process.env): boolean {
	const operator = normalizeEmail(env.ADMIN_EMAIL);
	return Boolean(operator) && normalizeEmail(email) === operator;
}