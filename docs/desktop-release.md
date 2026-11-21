# Building and deploying

This is a maintainer reference. For installation and normal use, start with [Getting started](getting-started.md).

The app is a Next.js server started with `npm run start` (or `npm run build` + a Node process on the standalone payload). The build still produces an isolated `.next/standalone` tree because [CI](../.github/workflows/ci.yml) runs packaged-payload gates against one on every supported OS; nothing shipped is a desktop installer, and updates are whatever the running host redeploys.

## Platforms

| Platform | CI runner | Standalone payload gate |
| --- | --- | --- |
| macOS, Apple Silicon | `macos-15` | `smoke-provider-runtime.mjs` |
| Windows, x64 | `windows-2025` | `smoke-provider-runtime.mjs` |
| Linux, x64 | `ubuntu-24.04` | `smoke-provider-runtime.mjs` |

CI uses **Node 26**. `plugins:build-core` must run before any build; `npm run build` does it, as does `npm run dev`.

## Build pipeline

1. `npm ci`
2. `npm run plugins:setup` on a fresh checkout
3. `npm run build` — stages core packages, runs `next build` (output `standalone`), then [postbuild](#postbuild-curation-and-guards)
4. `node scripts/smoke-provider-runtime.mjs` — imports the provider graph from the standalone payload only, so a dependency that escaped it fails loudly

`postbuild.mjs` needs a clean trace. `smoke-provider-runtime.mjs`, `smoke-image-runtime.mjs`, `smoke-compression-runtime.mjs` and `smoke-demo-runtime.mjs` all accept `--standalone <dir>` and fail if a dependency escapes the payload; only the provider gate is wired into CI today.

### postbuild: curation and guards

[`scripts/postbuild.mjs`](../scripts/postbuild.mjs) runs after every `next build`:

- copies `.next/static/` and `public/` in, and the native `scripts/plugin-loader.cjs` explicitly (it must stay outside the bundler's module graph);
- refuses to continue when the trace swept in the repo's `data/`, `auth.json`, `.env*`, or any `*-credentials.json` (see `outputFileTracingExcludes` in [`next.config.ts`](../next.config.ts) — the exclusion and the guard protect each other);
- removes only the standalone-root `plugins/` and `dist/` paths the trace over-collects (never a broad `dist/**`, which would eat dependency `dist/`), then checks the runtime-read prompt assets are present;
- rebuilds the plugin-authoring payload last, from current source.

Guards are not a substitute for inspecting a changed payload. [Postbuild refusal tests](../tests/web-subscription-payload.test.ts) pin the secret guards; [provider-tracing tests](../tests/provider-tracing.test.ts) pin the exclusion patterns.

## Local production check

1. Build as above.
2. Run the provider gate, then `node scripts/smoke-compression-runtime.mjs` and `node scripts/smoke-demo-runtime.mjs`.
3. `node scripts/smoke-web-subscriptions.mjs` — boots the built app and a dev server on fresh loopback ports with a throwaway profile and no network, then exercises cold catalogs, subscription status/consent/disconnect, the SSE owner across routes, the opaque sign-in redirect, CSRF refusal, and (dev) survival of a source edit.
4. Start it for real and check sign-in providers, a fixture lesson, PDF/SVG rendering, and the demo helper. Fixture gates do not prove account functionality or lesson quality.

Never point a smoke run at the installed app's real data or auth directories. Use throwaway directories and loopback providers rather than live accounts.

## Deploy checklist

1. Agree scope and version, complete the checks above and human functional acceptance.
2. Bump `package.json`/lockfile, land on the default branch, build from that exact commit.
3. Keep the payload built by that commit; do not rebuild an already-deployed tree from newer sources.
4. Check the running instance after cutover: cold start, sign-in status, one lesson, and that no `data/` or credential file from the source repo rode along.