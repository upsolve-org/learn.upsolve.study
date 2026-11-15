import assert from "node:assert/strict";
import { it } from "node:test";
import { pilotUserAllowed } from "../src/core/hosted-admission.ts";
import { proxy } from "../proxy.ts";
import { NextRequest } from "next/server";
import { createPluginDocumentRoute } from "../src/server/plugin-transport.ts";

it("single-account admission fails closed and cannot be expanded with an email list", () => {
	const user = { id: "9d0409ac-ee31-4944-8cc8-56ef5eb1bed5", email: "Invited@example.test" };
	assert.equal(pilotUserAllowed(user, "invited@example.test"), true);
	for (const allowed of ["", "other@example.test", "invited@example.test,other@example.test"]) assert.equal(pilotUserAllowed(user, allowed), false);
	assert.equal(pilotUserAllowed({ ...user, id: "../../data" }, user.email), false);
});

it("anonymous API and Proxy-exempt upload requests cannot touch learner data", async () => {
	const values = { HOSTED_MODE: "on", NEXT_PUBLIC_SUPABASE_URL: "https://supabase.invalid", NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "test", SUPABASE_DB_URL: "postgresql://unused", HOSTED_PILOT_EMAIL: "invited@example.test" };
	const saved = Object.fromEntries(Object.keys(values).map(k => [k, process.env[k]]));
	Object.assign(process.env, values);
	try {
		assert.equal((await proxy(new NextRequest("http://localhost/api/chats"))).status, 401);
		const route = createPluginDocumentRoute({ convertDocument: async () => { throw new Error("Must not dispatch"); } });
		const response = await route.POST(new Request("http://localhost/api/plugins/flashcards/documents/markdown", { method: "POST" }), { get params(): Promise<{id: string}> { throw new Error("Must not resolve params"); } });
		assert.equal(response.status, 401);
	} finally {
		for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
	}
});
