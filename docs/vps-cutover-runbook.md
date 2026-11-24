# VPS cutover runbook — self-hosted stack

Target: `flow-vps`, live app `/srv/learn` (`learn.service`, `next start` on
`127.0.0.1:8300`, behind Caddy). Goal: move auth, storage, blobs, browser
rendering and dictation onto self-hosted services in **one maintenance
window** without losing a single chat, graph node, image or password.

Ground rules:

- Nothing is deleted. The old tree stays at `/srv/learn-prev`, the Supabase
  containers are stopped (never `down -v`), and every copy script is
  read-only on its source.
- The final data copy runs with `learn.service` **stopped**, into an **empty**
  database: the copy scripts are insert-if-absent, so copying while the old
  app still writes would silently miss later edits.
- Run as root. Node lives at `/usr/local/lib/library-node/bin` (not on PATH):

```bash
export PATH=/usr/local/lib/library-node/bin:$PATH
export TSX="node --env-file=.env.local node_modules/tsx/dist/cli.mjs"
```

Tick a box only after its check passes.

## 0. Before the window (app still live)

### 0.1 Backups

- [ ] `mkdir -p /srv/backups && cd /srv/backups && STAMP=$(date +%F-%H%M)`
- [ ] Data tree: `tar czf learn-data-$STAMP.tar.gz -C /srv/learn data`
- [ ] Supabase auth schema (host has no `pg_dump`; 5432 is the pooler, so dump
      inside the DB container):
      `docker exec supabase-db pg_dump -U postgres --schema auth -Fc postgres > supabase-auth-$STAMP.dump`
- [ ] Config: `cp -a /srv/learn/.env.local env.local.$STAMP && cp -a /etc/caddy/Caddyfile Caddyfile.$STAMP`
- [ ] Verify: `tar tzf learn-data-$STAMP.tar.gz | wc -l` (non-zero) and
      `docker exec -i supabase-db pg_restore -l < supabase-auth-$STAMP.dump | grep -c TABLE` (non-zero).
- [ ] Baseline counts (keep the output):
      `docker exec supabase-db psql -U postgres -Atc "select count(*) from auth.users"` (17 on 2026-11-24; cut over at 00:38 UTC with 24 hosted chats),
      `find /srv/learn/data/hosted -path '*/chats/*.json' | wc -l`.

### 0.2 Stage the new tree at `/srv/learn-next`

- [ ] Copy the merged `main` (tarball or `git archive`) into `/srv/learn-next`.
      No `.env.local`, `data/`, `node_modules/` or `.next/` from the laptop.
- [ ] Write `/srv/learn-next/.env.local` from `deploy/.env.hosted.example`,
      carrying over `ADMIN_EMAIL`, `HOSTED_PILOT_EMAIL`, `HOSTED_DEFAULT_*`,
      `RESEND_*` and origins from the old file, and DROPPING every
      `SUPABASE_*` / `NEXT_PUBLIC_SUPABASE_*` key. Generate fresh secrets:
      `openssl rand -hex 32` for `POSTGRES_PASSWORD` (also inside
      `DATABASE_URL`), `BETTER_AUTH_SECRET` and `S3_SECRET_ACCESS_KEY`;
      `openssl rand -hex 10` for `S3_ACCESS_KEY_ID`. Set
      `STORAGE_BACKEND=postgres`, `CHROME_WS_ENDPOINT=ws://127.0.0.1:3003`,
      `STT_GATEWAY_URL=http://127.0.0.1:8792`.
      `chmod 600 .env.local && chown learn:learn .env.local`.
- [ ] Install and build (NEXT_PUBLIC_* values are inlined at build time, so
      `.env.local` must already be final):
      `cd /srv/learn-next && npm ci && npm run plugins:setup && npm run build`
      — build BEFORE any `data/` exists in this tree (postbuild refuses to
      package one). If `next build` stops with a Next.js security-advisory
      notice, just run `npm run build` again.
- [ ] `chown -R learn:learn /srv/learn-next`

### 0.3 Side-car services (no conflict with Supabase on 5432)

- [ ] `cd /srv/learn-next && docker compose --env-file .env.local -f deploy/docker-compose.yml up -d`
      → Postgres `127.0.0.1:5433`, RustFS `127.0.0.1:9000/9001`, Chromium `127.0.0.1:3003`.
- [ ] `docker compose -f deploy/docker-compose.yml exec postgres pg_isready -U learn -d learn`
- [ ] `curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3003/pressure` → `200`
- [ ] Create the bucket once:

```bash
cd /srv/learn-next && node --env-file=.env.local -e '
const { S3Client, CreateBucketCommand } = require("@aws-sdk/client-s3");
const c = new S3Client({ endpoint: process.env.S3_ENDPOINT, region: process.env.S3_REGION || "us-east-1", forcePathStyle: true,
  credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY } });
c.send(new CreateBucketCommand({ Bucket: process.env.S3_BUCKET })).then(() => console.log("bucket ok"), (e) => console.log(e.name));'
```

  `bucket ok` (or `BucketAlreadyOwnedByYou` on a re-run).

### 0.4 Rehearsal (proves the scripts; the data is thrown away)

- [ ] `cd /srv/learn-next && cp -a /srv/learn/data ./data`
- [ ] Point the auth copy straight at the `supabase-db` container (the old
      `SUPABASE_DB_URL` names a Supavisor tenant that does not exist; the
      script only SELECTs):

```bash
IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' supabase-db | awk '{print $1}')
PW=$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' supabase-db | grep '^POSTGRES_PASSWORD=' | cut -d= -f2-)
export SOURCE_DATABASE_URL="postgresql://postgres:$(python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=""))' "$PW")@$IP:5432/postgres"
```
- [ ] `$TSX --import tsx scripts/migrate-supabase-auth.ts` → `Verified all 17 source UUIDs …`
- [ ] `$TSX --import tsx scripts/migrate-fs-to-postgres.ts` → per-owner counts, no `!` rows
- [ ] `$TSX --import tsx scripts/migrate-blobs-to-rustfs.ts`
- [ ] Re-run all three: each must report nothing new (idempotence).
- [ ] Wipe the rehearsal: `docker compose -f deploy/docker-compose.yml exec postgres psql -U learn -d learn -c 'DROP SCHEMA public CASCADE; DROP SCHEMA IF EXISTS pgboss CASCADE; CREATE SCHEMA public AUTHORIZATION learn;'`
      and `rm -rf /srv/learn-next/data`. (RustFS objects are content-addressed and
      overwritten identically by the final copy.)

### 0.5 Prepare (do not apply yet)

- [ ] Caddy: write `/etc/caddy/Caddyfile.next` = the live file with ONLY the
      `learn.upsolve.study { … }` block replaced by `deploy/Caddyfile` (keep
      `import /etc/caddy/comprog/comprog.caddyfile` and any other site).
      `caddy validate --config /etc/caddy/Caddyfile.next --adapter caddyfile`.
- [ ] STT hardening (sherpa-onnx has no bind flag; ufw already blocks 8791
      externally, this makes it loopback-only at the socket level):

```bash
mkdir -p /etc/systemd/system/stt-server.service.d
printf '[Service]\nIPAddressDeny=any\nIPAddressAllow=localhost\n' > /etc/systemd/system/stt-server.service.d/loopback.conf
```

  (applied in step 2).

## 1. Maintenance window (downtime starts)

- [ ] `systemctl stop learn.service` and confirm `ss -ltnp | grep 8300` is empty.
      (`next start` ignores SIGINT, so systemd SIGKILLs it after the 20 s
      `TimeoutStopSec`; `systemctl stop` returns only once it is gone.)
- [ ] Final data snapshot into the new tree: `cp -a /srv/learn/data /srv/learn-next/data && chown -R learn:learn /srv/learn-next/data`
- [ ] Final copies into the EMPTY database (same commands as 0.4, from
      `/srv/learn-next`, with `SOURCE_DATABASE_URL` exported): auth →
      fs-to-postgres → blobs. Check: 17 users verified; every owner's chat
      count equals `find /srv/learn/data/hosted/<owner>/chats -name '*.json' | wc -l`; no `!` rows.
- [ ] Swap trees: `mv /srv/learn /srv/learn-prev && mv /srv/learn-next /srv/learn`
      (`learn.service` and `learn-worker.service` both point at `/srv/learn`).

## 2. Start the new stack

- [ ] `cp /srv/learn/deploy/learn-worker.service /etc/systemd/system/ && systemctl daemon-reload`
- [ ] `systemctl start learn.service` → `journalctl -u learn.service -n 50` shows
      `[postgres] storage backend active; … dispatched to the worker` and no errors.
- [ ] `systemctl enable --now learn-worker.service` → `journalctl -u learn-worker.service -n 20`
      shows `[worker] ready — consuming lh-subagent-job`.
- [ ] `cp /etc/caddy/Caddyfile.next /etc/caddy/Caddyfile && systemctl reload caddy`
- [ ] `systemctl restart stt-server.service` (picks up the loopback drop-in) and
      `curl -fsS http://127.0.0.1:8792/health`.
- [ ] Stop Supabase WITHOUT removing anything:
      `docker stop $(docker ps --format '{{.Names}}' | grep -E '^(supabase-|realtime-dev\.supabase)')`

## 3. Smoke test (downtime ends when this passes)

- [ ] An existing user signs in **with their existing password** (everyone is
      signed out once — the session cookies changed).
- [ ] Chat list renders; a recent chat opens with its full history and images.
- [ ] A research job: the job card completes and the result lands in the
      lesson (worker ran it; the web process delivered it). Cancel one too.
- [ ] Dictation: one utterance inserts text (`/api/stt/token` → `mode: local`).
- [ ] A demo job verifies through Chromium; `docker ps` still shows the
      browserless container afterwards.
- [ ] `https://learn.upsolve.study` loads and the comprog site still serves.

## 4. Rollback (any time during the soak)

```bash
systemctl stop learn-worker.service learn.service
docker start $(docker ps -a --format '{{.Names}}' | grep -E '^(supabase-|realtime-dev\.supabase)')
mv /srv/learn /srv/learn-failed && mv /srv/learn-prev /srv/learn
cp /srv/backups/Caddyfile.<STAMP> /etc/caddy/Caddyfile && systemctl reload caddy
systemctl start learn.service
```

The old tree's `data/` is exactly the pre-cutover state. Anything learners
wrote after the cutover lives only in Postgres (`learn-hosted` volumes) and
needs a reverse copy before a permanent rollback.

## 5. Soak and decommission

- [ ] Soak at least one full weekday with Supabase **stopped, not removed**.
- [ ] After sign-off: remove the Supabase containers/images but **keep their
      volumes** until a separately approved retention window ends. Keep
      `/srv/learn-prev` and `/srv/backups` for the same window.
