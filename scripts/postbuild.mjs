/**
 * postbuild.mjs — finish the standalone payload after `next build`.
 *
 * Traced Server Components Output pulls two kinds of files Next itself does
 * not copy in: runtime assets (public/, .next/static/, the native plugin
 * loader, core plugins) and repo-root paths the trace sweep over-collects.
 * This script copies the former, curates away the latter, and fails loudly
 * when dev-only data or secrets ride along (see next.config.ts
 * outputFileTracingExcludes). Plugin authoring assets are assembled last,
 * from current source.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { validateCorePackages } from "./build-core-plugins.mjs";
import { buildPluginAuthoring } from "./build-plugin-authoring.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const STANDALONE = path.join(ROOT, ".next", "standalone");
const copyTree = (from, to) => fs.cpSync(from, to, { recursive: true });
const exists = (p) => fs.existsSync(p);
const refuse = (...lines) => { for (const line of lines) console.error(`[postbuild] ${line}`); process.exit(1); };

if (!exists(path.join(STANDALONE, "server.js"))) refuse(".next/standalone/server.js missing — run `next build` first (output: 'standalone').");

// 1) Static assets: public/ → standalone/public, .next/static → standalone/.next/static
if (!exists(path.join(ROOT, ".next", "static"))) refuse(".next/static missing — the build looks incomplete.");
copyTree(path.join(ROOT, ".next", "static"), path.join(STANDALONE, ".next", "static"));
if (exists(path.join(ROOT, "public"))) copyTree(path.join(ROOT, "public"), path.join(STANDALONE, "public"));

// 2) Safety: the repo's real data/ must NEVER ride along in the bundle.
if (exists(path.join(STANDALONE, "data"))) refuse("REFUSING: standalone contains a data/ directory — repo session data would ship in the app.", "Check outputFileTracingExcludes in next.config.ts.");

// 2b) Safety: the repo's dev SECRETS must never ride along either — the same
// trace sweep once shipped the repo-root auth.json (the DEV BYOK key store)
// byte-identical into the DMG (2026-10-08 payload audit; excluded in
// next.config.ts — this guard makes a regression loud instead of silent).
const subscriptionSecrets = fs.readdirSync(STANDALONE).filter((name) => /^(chatgpt|github-copilot|xai)-credentials\.json/.test(name));
for (const secret of ["auth.json", ...subscriptionSecrets, ".env", ".env.local"]) {
	if (exists(path.join(STANDALONE, secret))) refuse(`REFUSING: standalone contains ${secret} — dev secrets would ship in the app.`, "Check outputFileTracingExcludes in next.config.ts.");
}

// Assemble plugin assets only after refusing unsafe traced data/credentials.
// The runtime native plugin loader stays outside Next's module graph; copy it
// explicitly so webpack/Turbopack never interprets it as a build-time import.
if (!exists(path.join(ROOT, "scripts", "plugin-loader.cjs"))) refuse("scripts/plugin-loader.cjs missing.");
copyTree(path.join(ROOT, "scripts", "plugin-loader.cjs"), path.join(STANDALONE, "scripts", "plugin-loader.cjs"));
try {
	const core = path.join(ROOT, "core-plugins"), packagedCore = path.join(STANDALONE, "core-plugins");
	validateCorePackages(ROOT, core);
	fs.rmSync(packagedCore, { recursive: true, force: true });
	copyTree(core, packagedCore);
	validateCorePackages(ROOT, packagedCore);
} catch (error) {
	refuse("REFUSING: Core plugin payload is missing or unsafe. Run npm run plugins:build-core.", error);
}

// 2c) Payload curation (2026-10-11): the trace sweep can copy repo-root
// plugins/ (authoring sources/tests) and dist/ (previous builds). Remove ONLY
// these standalone-root paths AFTER tracing — excluding a generic dist/**
// earlier broke pi-ai / pi-agent-core's runtime dist/.
for (const extra of ["plugins", "dist"]) {
	const target = path.join(STANDALONE, extra);
	if (exists(target)) {
		fs.rmSync(target, { recursive: true, force: true });
		console.log(`[postbuild] removed build-only payload: ${extra}`);
	}
}

// 3) Sanity: the runtime-read prompt assets must be present (the teacher
//    agent reads them from disk at request time).
for (const asset of [
	path.join("scripts", "plugin-loader.cjs"),
	path.join("public", "plugin-loader.js"),
	path.join("src", "agent", "system-prompt.md"),
	path.join("src", "agent", "prompts", "teacher", "20-teaching.md"),
	path.join("src", "agent", "prompts", "side-chat", "00-base.md"),
	path.join("src", "agent", "prompts", "side-chat", "90-style.md"),
]) {
	if (!exists(path.join(STANDALONE, asset))) refuse(`prompt asset missing from the trace: ${asset}`);
}

// Reassemble from current source, never reuse a potentially stale dev copy.
buildPluginAuthoring({ root: ROOT, standalone: true });

console.log("[postbuild] standalone payload ready:", STANDALONE);