/**
 * Demos run in system Chrome/Chromium via puppeteer-core (the Electron
 * browser-service helper is gone). These pin what is left as a pure seam:
 * Chrome resolution and the availability gate. The live chain (launch →
 * pages() → run) is exercised on dev machines, not in the suite.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, afterEach } from "node:test";
import { resolveChromeExecutablePath, realHeadless } from "../src/agent/subagents/headless.ts";

const saved = { CHROME_PATH: process.env.CHROME_PATH };
afterEach(() => {
	for (const [key, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

describe("system Chrome resolution", () => {
	it("prefers an existing CHROME_PATH", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-chrome-"));
		const binary = path.join(dir, "chrome");
		fs.writeFileSync(binary, "");
		try {
			process.env.CHROME_PATH = binary;
			assert.equal(resolveChromeExecutablePath(), binary);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("ignores a CHROME_PATH that does not exist", () => {
		process.env.CHROME_PATH = path.join(os.tmpdir(), "lh-no-such-chrome-binary");
		assert.notEqual(resolveChromeExecutablePath(), process.env.CHROME_PATH);
	});

	it("ignores an empty CHROME_PATH", () => {
		process.env.CHROME_PATH = "";
		assert.notEqual(resolveChromeExecutablePath(), "");
	});
});

describe("availability gate", () => {
	it("is available exactly when a Chrome executable resolves", () => {
		assert.equal(realHeadless.available(), resolveChromeExecutablePath() !== null);
		assert.equal(realHeadless.unavailableReason() === null, realHeadless.available());
		if (!realHeadless.available()) assert.match(realHeadless.unavailableReason() ?? "", /CHROME_PATH/);
	});
});