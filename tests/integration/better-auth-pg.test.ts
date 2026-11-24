/**
 * Real PostgreSQL 17 + Better Auth integration test:
 *   1. provisionDatabaseUser creates a user + bcrypt credential row in Postgres
 *      and preserves the user's UUID on re-provisioning (password rotation).
 *   2. Better Auth signs the user in against the real Postgres tables and
 *      resolves the session cookie back to the canonical lowercase user ID.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { closePgPool, getPgPool, runMigrations } from "../../src/server/db.ts";
import { getAuth, getSessionUser, provisionDatabaseUser, verifyPassword } from "../../src/server/auth.ts";

assert.ok(process.env.DATABASE_URL?.trim(), "DATABASE_URL must be set for integration tests");
assert.ok(process.env.BETTER_AUTH_SECRET?.trim(), "BETTER_AUTH_SECRET must be set for integration tests");

const pool = getPgPool();
const testEmail = `ci-${randomUUID().slice(0, 8)}@example.test`;
let createdUserId: string | null = null;

before(async () => {
	await runMigrations(pool);
});

after(async () => {
	if (createdUserId) {
		await pool.query('DELETE FROM "session" WHERE "userId" = $1', [createdUserId]);
		await pool.query('DELETE FROM "account" WHERE "userId" = $1', [createdUserId]);
		await pool.query('DELETE FROM "user" WHERE id = $1', [createdUserId]);
	}
	await closePgPool();
});

describe("Better Auth + PostgreSQL", () => {
	it("provisions a user, preserves UUID on password update, and signs in with a live session", async () => {
		const first = await provisionDatabaseUser(testEmail, "InitialPass#123", pool);
		assert.equal(first.ok, true);
		if (!first.ok) return;
		createdUserId = first.userId;

		// Re-provisioning updates the password hash while keeping the same owner UUID.
		const second = await provisionDatabaseUser(testEmail, "RotatedPass#456", pool);
		assert.equal(second.ok, true);
		if (!second.ok) return;
		assert.equal(second.userId, first.userId, "re-provisioning must never rotate the owner UUID");

		const { rows } = await pool.query<{ password: string }>(
			'SELECT password FROM "account" WHERE "userId" = $1 AND "providerId" = $2',
			[createdUserId, "credential"],
		);
		assert.equal(rows.length, 1);
		assert.equal(await verifyPassword({ hash: rows[0]!.password, password: "InitialPass#123" }), false);
		assert.equal(await verifyPassword({ hash: rows[0]!.password, password: "RotatedPass#456" }), true);

		// Sign in via Better Auth HTTP handler to obtain a real session cookie.
		const auth = getAuth();
		const signInResponse = await auth.handler(
			new Request("http://127.0.0.1:3000/api/auth/sign-in/email", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ email: testEmail, password: "RotatedPass#456" }),
			}),
		);
		assert.equal(signInResponse.status, 200, await signInResponse.clone().text());

		const setCookies = signInResponse.headers.getSetCookie?.() ?? [];
		const cookieHeader = setCookies.map((c) => c.split(";")[0]).join("; ");
		assert.ok(cookieHeader.length > 0, "sign-in must issue a session cookie");

		const sessionUser = await getSessionUser(new Headers({ cookie: cookieHeader }));
		assert.deepEqual(sessionUser, {
			id: createdUserId.toLowerCase(),
			email: testEmail,
		});
	});
});
