# VPS cutover runbook — self-hosted stack (PR 7)

Target: `flow-vps`, app root `/srv/learn`. Goal: move auth, storage, blobs,
browser rendering and dictation onto self-hosted services **without losing a
single chat, graph node, image or user password**. The old Supabase containers
stay running (and their volumes stay on disk) throughout the soak period.

Do each step in order. Tick a box only after its verification passes. Nothing
in steps 1–4 touches the live app — those steps are additive and run on new
loopback ports only.

## 1. Pre-flight backups

- [ ] Snapshot the app data directory: `tar czf /srv/backups/learn-data-$(date +%F).tar.gz -C /srv/learn data`
- [ ] Dump the Supabase `auth` schema (users + bcrypt hashes; they are carried
      across verbatim so nobody has to reset a password):
      `pg_dump --host 127.0.0.1 --port 5432 --username postgres --schema auth --format=custom --file=/srv/backups/supabase-auth-$(date +%F).dump postgres`
- [ ] Copy the current config off-box:
      `cp /srv/learn/.env.local /srv/backups/env.local.before-cutover` and
      `cp /etc/caddy/Caddyfile /srv/backups/Caddyfile.before-cutover`.
- [ ] Confirm the backups are non-empty and can be listed/read:
      `tar tzf /srv/backups/learn-data-*.tar.gz | head` and
      `pg_restore -l /srv/backups/supabase-auth-*.dump | head`.
- [ ] Record current user count and chat count (for the count checks in step 3).

## 2. Start the new side-car stack (no conflict with Supabase)

- [ ] `cd /srv/learn && docker compose --env-file .env.local -f deploy/docker-compose.yml up -d`
      (Postgres `127.0.0.1:5433`, RustFS `127.0.0.1:9000`/`9001`, Chromium
      `127.0.0.1:3003`). Supabase remains on `127.0.0.1:5432`.
- [ ] Postgres healthy: `docker compose -f deploy/docker-compose.yml exec postgres pg_isready -U learn -d learn`.
- [ ] Create the blob bucket once (RustFS console on `127.0.0.1:9001`, or the
      S3 CLI with `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY`): bucket name
      **`learn-blobs`**.
- [ ] Chromium reachable: `curl -fsS http://127.0.0.1:3003/pressure` returns OK.
      Set `CHROME_WS_ENDPOINT=ws://127.0.0.1:3003` (browserless spawns a fresh
      sandboxed browser session per CDP connection on the root WS endpoint).

## 3. Non-destructive, idempotent migrations (order matters)

Each script copies data; none deletes the source. Run them while the old app
is still live, then **check every count** against the pre-flight numbers.

- [ ] Auth: `/usr/local/bin/library-node node_modules/tsx/dist/cli.mjs --import tsx scripts/migrate-supabase-auth.ts`
      → users migrated = pre-flight user count; verify bcrypt hashes match
      (`SELECT count(*) FROM "account" WHERE password IS NOT NULL`).
- [ ] Rows: `… scripts/migrate-fs-to-postgres.ts` → chats, messages, graph
      nodes, settings and jobs counts all equal the pre-flight counts.
- [ ] Blobs: `… scripts/migrate-blobs-to-rustfs.ts` → snapshot/upload object
      count equals the number of local image files; spot-check one object is
      downloadable from `learn-blobs`.
- [ ] Re-run all three scripts a second time: they must be no-ops (zero new
      rows/objects) — this proves idempotence before cutover.

## 4. Harden the existing STT sidecar

- [ ] Edit `stt-server.service` so `sherpa-onnx` binds **`127.0.0.1:8791`**
      instead of `0.0.0.0:8791` (the transcription gateway proxies to it).
      `sudo systemctl daemon-reload && sudo systemctl restart stt-server.service`.
- [ ] `curl -fsS http://127.0.0.1:8792/health` returns healthy. The app's
      `STT_GATEWAY_URL=http://127.0.0.1:8792` now resolves local dictation.
- [ ] Confirm the port is loopback-only: `ss -ltnp | grep 8791` shows
      `127.0.0.1:8791`, not `0.0.0.0:8791`.

## 5. Build, swap config, install services, reload Caddy

- [ ] Build the app from this checkout: `cd /srv/learn && npm run build`.
- [ ] Swap in the new config from `deploy/.env.hosted.example`: set
      `HOSTED_MODE=on`, the loopback `DATABASE_URL` (port 5433),
      `BETTER_AUTH_SECRET`, `S3_*`, `CHROME_WS_ENDPOINT`, `STT_GATEWAY_URL`,
      origins and admin email. `chmod 600 /srv/learn/.env.local`.
- [ ] Install and start the worker:
      `sudo cp deploy/learn-worker.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now learn-worker.service`
      — check `journalctl -u learn-worker.service -n 50` for a clean start.
- [ ] Replace `/etc/caddy/Caddyfile` with `deploy/Caddyfile` (no `/auth/v1/*`
      proxy — Better Auth replaces GoTrue), then
      `sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy`.
- [ ] Restart the web app: `sudo systemctl restart learn.service`. Confirm
      `journalctl -u learn.service -n 50` has no migration/connection errors.

## 6. Smoke test (after cutover)

- [ ] Existing user signs in **with their existing password** — no reset.
- [ ] Chat list renders; a recent chat opens with full message history.
- [ ] Image snapshots display (including `?format=raw`), and a new chat image
      is stored in `learn-blobs` rather than Postgres.
- [ ] Background job runs (job card completes) and its SSE live update arrives
      through the worker's LISTEN/NOTIFY bridge.
- [ ] Parakeet dictation: one utterance produces inserted text via
      `/api/stt/transcribe` (token route reports `mode: local`).
- [ ] Demo-builder Chromium verification runs through `CHROME_WS_ENDPOINT`;
      the browserless container is still alive afterward (we disconnect,
      never close it).

## 7. Soak, rollback, and decommission

- [ ] Soak for at least one full weekday traffic cycle with the Supabase
      containers **stopped but NOT removed** (`docker compose stop` — keep the
      volumes). Do not run `docker compose down -v`.
- [ ] Rollback if needed: restore the pre-cutover `.env.local` and Caddyfile
      from step 1, `systemctl stop learn-worker.service`, restart
      `learn.service`, start Supabase again, and reload Caddy. Data written
      during the soak needs a reverse migration before a permanent rollback.
- [ ] Only after the soak period ends and sign-off is recorded: remove the
      old Supabase containers/images. **Still keep their volumes** until a
      separate, explicitly approved retention window expires.
