import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// config.ts resolves LH_DATA_DIR at module load, so every import that can
// reach it is dynamic, after the root exists.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-request-owner-"));
process.env.LH_DATA_DIR = dataDir;

const { ownerScoped, ownerOfRequest, OWNER_HEADER } = await import("../src/server/request-owner.ts");
const { currentOwnerId } = await import("../src/core/owner-scope.ts");

const A = "9d0409ac-ee31-4944-8cc8-56ef5eb1bed5";
const B = "0f0e0d0c-0b0a-4908-8706-050403020100";

const saved = { HOSTED_MODE: process.env.HOSTED_MODE };

function request(owner?: string): Request {
	return new Request("http://localhost/api/x", { headers: owner === undefined ? {} : { [OWNER_HEADER]: owner } });
}

beforeEach(() => { process.env.HOSTED_MODE = "on"; });
afterEach(() => {
	if (saved.HOSTED_MODE === undefined) delete process.env.HOSTED_MODE;
	else process.env.HOSTED_MODE = saved.HOSTED_MODE;
});

describe("request owner", () => {
	it("reads and canonicalises the forwarded header", () => {
		assert.equal(ownerOfRequest(request(A.toUpperCase())), A);
		assert.equal(ownerOfRequest(request(`  ${A}  `)), A);
	});

	it("rejects a missing or malformed header", () => {
		for (const value of [undefined, "", "nope", "../../etc", `${A}/x`]) {
			assert.equal(ownerOfRequest(request(value)), undefined, String(value));
		}
	});

	it("ignores the header entirely when hosted mode is off", () => {
		process.env.HOSTED_MODE = "off";
		assert.equal(ownerOfRequest(request(A)), undefined);
	});
});

describe("ownerScoped", () => {
	it("runs the handler inside the caller's scope and passes arguments through", () => {
		const handler = ownerScoped((req: Request, extra: string) => {
			assert.equal(req.url, "http://localhost/api/x");
			return `${currentOwnerId() ?? "none"}:${extra}`;
		});
		assert.equal(handler(request(A), "x"), `${A}:x`);
		assert.equal(currentOwnerId(), undefined, "scope ends with the handler");
	});

	it("keeps two requests isolated", () => {
		const handler = ownerScoped((_req: Request) => currentOwnerId());
		assert.equal(handler(request(A)), A);
		assert.equal(handler(request(B)), B);
	});

	it("runs unscoped when the header is absent", () => {
		const handler = ownerScoped((_req: Request) => currentOwnerId() ?? "none");
		assert.equal(handler(request()), "none");
	});

	it("stays synchronous so a sync handler returns a plain value", () => {
		const handler = ownerScoped((_req: Request) => 42);
		const result = handler(request(A));
		assert.equal(typeof result, "number");
		assert.equal(result, 42);
	});

	it("propagates a throw without leaking the scope", () => {
		const handler = ownerScoped((_req: Request) => { throw new Error("boom"); });
		assert.throws(() => handler(request(A)), /boom/);
		assert.equal(currentOwnerId(), undefined);
	});
});