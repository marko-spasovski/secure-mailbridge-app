# Deployment: AWS lab (single container behind Nginx/ModSecurity)

Target: one container on an Ubuntu 24.04 EC2 host (t3.small, linux/amd64), image from ECR pinned by digest,
plain HTTP on TCP 3000 behind Nginx + ModSecurity on another host (TLS ends there), reached only through a VPN at
`https://mail.<domain>`. PostgreSQL 16 on `10.0.4.10:5432`, database `mailbridge`, user `mailbridge` (owns the
database, not a superuser, cannot create roles or databases), empty at every start. Egress: TCP 443 and DNS only.
Secrets arrive as environment variables from AWS SSM.

Contents: [1 Inventory](#1-inventory) · [2 Gaps and status](#2-gaps-and-status) ·
[3 Running it in the lab](#3-running-it-in-the-lab) · [4 Optional: least-privilege runtime role (ADR 0008)](#4-optional-least-privilege-runtime-role-adr-0008) ·
[5 Verification report](#5-verification-report) · [6 Decisions](#6-decisions-and-remaining-lab-decisions)

---

## 1. Inventory

### Stack and versions

| Part | Version | Notes |
|---|---|---|
| Node.js | 24.21.0 (`node:24.21.0-bookworm-slim`, pinned by digest in `Dockerfile`) | `engines.node >= 24` |
| Language | TypeScript, compiled with `tsc` to `dist/` (ESM) | no bundler |
| Web framework | Express 5.3.0 | |
| Sessions | express-session 1.19.0 + connect-pg-simple 10.0.0 | stored in table `sessions` |
| Database driver | pg 8.23.1 (raw parameterized SQL, no ORM) | pool of 10 |
| Migrations | node-pg-migrate 9.0.0, plain SQL files in `database/migrations/` | 13 migrations |
| OAuth | Microsoft: @azure/msal-node 7.1.0 · Google: hand-written OAuth 2.0 + PKCE over `fetch` | |
| Passwords | argon2 0.45.1 (Argon2id, native module with prebuilt binaries) | |
| Outgoing SMTP | nodemailer 10.2.1 (password-reset mail only, optional, off in the lab) | |
| Logging | pino 10.4.0 + pino-http 11.0.0, JSON lines on stdout | redaction list in `src/config/logger.ts` |
| Validation | zod 4.6.7 | env and every request |
| Config loading | dotenv 18.0.7 (`import 'dotenv/config'`) | reads `./.env` only if one exists; the image has none |
| Frontend | vanilla JS/CSS/HTML in `public/`, served by Express, no CDN, strict CSP | |

### How it starts

- Build: `npm ci && npm run build && npm prune --omit=dev` (inside the Dockerfile's build stage).
- Start: `node dist/server.js` (the image's `CMD`).
- On start `src/server.ts`:
  1. parses and validates all env vars (`src/config/env.ts`); an invalid one stops the process and names the
     variable, never its value;
  2. creates the pg pool, runs `SELECT 1`, then checks that every required table exists. **If the schema is missing it
     logs a fatal line and exits with code 1; it does not run migrations itself** (see [§3](#3-running-it-in-the-lab));
  3. listens on `PORT` (3000), all interfaces;
  4. on SIGTERM/SIGINT: stops accepting connections, closes idle keep-alive connections, lets in-flight requests
     finish for up to **8 s**, then closes what is left, ends the pool, logs `shut down` and exits 0
     (`src/http/shutdown.ts`). This fits inside Docker's default 10 s stop timeout.
- One-shot commands in the image (same env as the app):
  - `node dist/scripts/migrate.js`: apply pending migrations (`down <n>` rolls back);
  - `node dist/scripts/reset-password.js`: set a user's password (`RESET_USER_EMAIL`, `RESET_USER_PASSWORD`);
  - `node dist/scripts/reseal-credentials.js`: re-encrypt tokens after key rotation (`docs/runbooks/key-rotation.md`).
- No background workers or timers. Mail sync runs inside HTTP requests.

### Environment variables

Everything is read once in `src/config/env.ts`. [`.env.example`](../.env.example) lists every variable with comments.

| Variable | Purpose | Required | Secret | Example / format |
|---|---|---|---|---|
| `NODE_ENV` | `production` enables the production checks, `__Host-` Secure cookie, HSTS | **yes** | no | `production` |
| `PORT` | listen port | no | no | `3000` (default) |
| `LOG_LEVEL` | pino level | no | no | `info` (default) · `fatal` `error` `warn` `debug` `trace` `silent` |
| `PUBLIC_ORIGIN` | public origin: OAuth redirect URIs, reset links, the only accepted `Origin` for writes | **yes** (prod) | no | `https://mail.<domain>` (https, no path, no trailing slash) |
| `TRUST_PROXY` | proxy hops whose `X-Forwarded-For`/`-Proto` are trusted | **yes, ≥ 1** (prod) | no | `1` |
| `SESSION_SECRET` | signs the session cookie, keys the rate-limit counters | **yes** | **yes** | raw text, ≥ 32 chars, see [secret format](#secret-format) |
| `TOKEN_ENCRYPTION_KEY` | AES-256-GCM key (HKDF-SHA256) for stored mailbox OAuth tokens | **yes** (prod) | **yes** | raw text, ≥ 32 chars, ≠ `SESSION_SECRET` |
| `TOKEN_ENCRYPTION_KEY_PREVIOUS` | old key, only during key rotation | no | **yes** | unset normally |
| `POSTGRES_HOST` | DB host | **yes** | no | `10.0.4.10` |
| `POSTGRES_PORT` | DB port | **yes** | no | `5432` |
| `POSTGRES_DB` | DB name | **yes** | no | `mailbridge` |
| `POSTGRES_USER` | DB user | **yes** | no | `mailbridge` (or `mailbridge_app`, [§4](#4-optional-least-privilege-runtime-role-adr-0008)) |
| `POSTGRES_PASSWORD` | DB password | **yes** | **yes** | from SSM |
| `POSTGRES_SSL` | TLS to PostgreSQL, always fully verified when on | no | no | `false` (default) · `true` |
| `POSTGRES_SSL_CA` | PEM of the CA that signed the server certificate | no (only with `POSTGRES_SSL=true`) | no | `-----BEGIN CERTIFICATE-----\n…` (real or literal `\n`) |
| `ALLOW_REGISTRATION` | anyone reaching the app may sign up | no | no | `true` (default) · `false` |
| `MICROSOFT_CLIENT_ID` | Entra application (client) ID | no (both or neither) | no¹ | GUID |
| `MICROSOFT_CLIENT_SECRET` | Entra client secret | no (both or neither) | **yes** | from SSM |
| `MICROSOFT_TENANT` | sign-in authority | no | no | `common` (default), `organizations`, `consumers`, tenant ID |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID | no (both or neither) | no¹ | `….apps.googleusercontent.com` |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret | no (both or neither) | **yes** | from SSM |
| `GMAIL_ALLOWED_EMAILS` | optional invite list of app sign-in emails allowed to connect Gmail | no | no (personal data) | `a@x.test,b@y.test`; empty = everyone |
| `SMTP_HOST` `SMTP_PORT` `SMTP_SECURE` `SMTP_USER` `SMTP_FROM` | password-reset mail | no | no | **leave unset in the lab** (G8) |
| `SMTP_PASSWORD` | SMTP auth | no | **yes** | unset |
| `NODE_OPTIONS` | Node runtime flags (not read by the app) | no | no | `--max-old-space-size=384` |
| `RENDER_EXTERNAL_URL` | Render.com fallback for `PUBLIC_ORIGIN` | no | no | leave unset |

¹ OAuth client IDs are public by design (they appear in the browser's authorize URL); keeping them in SSM is harmless.

#### Secret format

`SESSION_SECRET`, `TOKEN_ENCRYPTION_KEY` (and `TOKEN_ENCRYPTION_KEY_PREVIOUS`) are **raw text, used exactly as
given**. The app does **not** decode hex or base64; the string's characters are the secret. Surrounding whitespace is
trimmed. Production refuses to start unless each is **at least 32 characters**, does not start with `REPLACE_`, and
the two differ.

- Recommended: **64 hexadecimal characters** (32 random bytes = 256 bits), generated independently for each, e.g.
  `openssl rand -hex 32`. Base64 output (`openssl rand -base64 32`, 44 characters) is also accepted.
- ASCII only, one line. Whatever the generator produces, inject the same string every time: a different
  `TOKEN_ENCRYPTION_KEY` cannot decrypt tokens stored with the old one (the user has to reconnect the mailbox), and a
  different `SESSION_SECRET` signs everyone out. With the lab's database rebuilt each session, a new key per session is fine.

### Ports

- Inbound: TCP 3000, plain HTTP. Nothing else listens.
- Outbound: see below.

### Database access and migrations

- `pg.Pool` (max 10, idle 30 s, connect timeout 5 s). All SQL parameterized; every query on user data is scoped by
  `user_id`. The pool and the migrator share one connection builder (`connectionOptions` in
  `src/config/database.ts`), so TLS settings apply to both.
- `node-pg-migrate`, `singleTransaction: true`, `checkOrder: true`, bookkeeping table `pgmigrations`. Applied
  migrations are skipped, so running it on every start is idempotent. It takes a PostgreSQL advisory lock, so two
  concurrent runs do not both migrate.
- What the migrations need from the role: `CREATE` on schema `public` (the database owner has it: since PG15 `public` is
  owned by `pg_database_owner`), plus:
  - **Extensions: only `pg_trgm`** (`012_mail_search.sql`). It is **trusted** since PostgreSQL 13, so a non-superuser
    database owner may create it on PG16 (verified, [§5](#5-verification-report)). It ships in the standard
    PostgreSQL packages (`postgresql-16` on Debian/Ubuntu, the official image, RDS).
  - `gen_random_uuid()` is **built in since PostgreSQL 13**. `pgcrypto` and `uuid-ossp` are **not** used.
  - Two `plpgsql` trigger functions (audit-log guard); `plpgsql` is installed in every database.
  - No `CREATE ROLE`, `GRANT`, `ALTER … OWNER`, `SECURITY DEFINER`, custom collation or superuser-only feature.
- TLS (`POSTGRES_SSL=true`): `rejectUnauthorized: true` with Node's default hostname check, so the server
  certificate must chain to a trusted CA (`POSTGRES_SSL_CA` or the system store) **and** name `POSTGRES_HOST`. For
  `10.0.4.10` that means an **IP SAN `10.0.4.10`** in the certificate. There is deliberately no "encrypt without
  verifying" mode: it would let anyone on the path impersonate the database.

### OAuth flows

Both are authorization-code flows with PKCE (S256), a 32-byte random `state` kept in the server-side session,
compared in constant time, 10-minute expiry, and bound to the provider it was started for.

| | Microsoft (Graph) | Google (Gmail API) |
|---|---|---|
| Start | `GET /accounts/connect/outlook` → 302 to `login.microsoftonline.com/<tenant>/oauth2/v2.0/authorize` | `GET /accounts/connect/gmail` → 302 to `accounts.google.com/o/oauth2/v2/auth` |
| **Redirect URI to register** | **`https://mail.<domain>/accounts/callback/outlook`** | **`https://mail.<domain>/accounts/callback/gmail`** |
| Scopes | `User.Read`, `Mail.ReadWrite`, `Mail.Send`, `offline_access` | `openid email profile gmail.modify gmail.send` |
| Code exchange | MSAL `acquireTokenByCode` → `login.microsoftonline.com` | `POST oauth2.googleapis.com/token` |
| Profile | `graph.microsoft.com/v1.0/me` | `openidconnect.googleapis.com/v1/userinfo` |
| Stored | MSAL token cache + home account ID, AES-256-GCM (AAD = account ID) | refresh + access token, same encryption |
| Refresh | MSAL `acquireTokenSilent` | `POST oauth2.googleapis.com/token` |

The redirect URIs are built as `${PUBLIC_ORIGIN}/accounts/callback/<provider>` in `src/app.ts`; no host is hardcoded.
The session cookie is `SameSite=Lax`, which the callback needs: the provider returns the browser with a top-level
GET, and a `Strict` cookie would not be sent with it.

### Outbound hosts at runtime (all HTTPS, TCP 443)

| Host | Used by | When |
|---|---|---|
| `login.microsoftonline.com` | MSAL: authority metadata and instance discovery, code exchange, token refresh | Outlook connect and token refresh |
| `graph.microsoft.com` | profile, mail sync (delta), read, send, attachments | Outlook use |
| `oauth2.googleapis.com` | code exchange, token refresh | Gmail connect and refresh |
| `openidconnect.googleapis.com` | userinfo after connect | Gmail connect |
| `gmail.googleapis.com` | mail sync, read, send, attachments | Gmail use |
| `10.0.4.10:5432` (TCP) | PostgreSQL | always |

Plus DNS for those names. `accounts.google.com` and the Microsoft authorize page are opened by the **user's browser**
(302 redirects), not by the server. Nothing contacts a CDN, font service, telemetry or update endpoint; the frontend
loads only same-origin files (CSP `default-src 'self'`). Provider continuation URLs (Graph `@odata.nextLink` /
`deltaLink`, attachment URLs) are checked against an origin and path allowlist before they are fetched, and every
outbound `fetch` uses `redirect: 'error'` and a timeout. No package installs at start. SMTP (587/465) is only used if
`SMTP_HOST` is set, and must stay unset in the lab.

### Health endpoint

`GET /healthz` (and the older `GET /health`) → `200 {"status":"ok"}` after a `SELECT 1` on the pool; a database
failure gives `500` with the standard error body. No session, no provider call, not logged. In
`contracts/openapi.yaml`. The image's `HEALTHCHECK` probes `/healthz` every 30 s.

### Logging

- JSON lines on stdout. Redacted: cookies, `Authorization`, `Set-Cookie`, and any `password`, `token`,
  `accessToken`, `refreshToken`, `credentials`, `secret`, `code` field. Request lines carry method, path (no query
  string), status, request ID, `userId` and the client IP (from `X-Forwarded-For`, one hop trusted).
- Mail content, tokens and passwords are never logged. Email addresses go to the `audit_events` table, not the logs
  (verified: a register and two logins left no address or password in the log).
- Errors on every line (requests, start-up, shutdown) are logged as type, code and stack, never the message.

---

## 2. Gaps and status

| # | Gap | Severity | Status |
|---|---|---|---|
| G1 | Single redirect URI `/oauth/callback` did not exist | High | **Decided: no new route.** The lab registers the two existing URIs (above); the base comes from `PUBLIC_ORIGIN`. |
| G2 | No `/healthz` | Low | **Done**: `GET /healthz` alias, contract, tests; `HEALTHCHECK` uses it. |
| G3 | `TRUST_PROXY=0` behind Nginx silently drops the Secure session cookie | High | **Done**: production refuses to start with `TRUST_PROXY < 1`; test + mutation. |
| G4 | Schema not created at start | High | **Done (procedure)**: run the one-shot migrate command before the app on every start ([§3](#3-running-it-in-the-lab)); verified idempotent. |
| G5 | Least-privilege runtime role (ADR 0008) | Medium | **Described for the lab to decide** ([§4](#4-optional-least-privilege-runtime-role-adr-0008)); tested on PG16, no code change needed. |
| G6 | No TLS to PostgreSQL | Medium | **Done**: optional `POSTGRES_SSL` / `POSTGRES_SSL_CA`, off by default, always verified; tests + mutations. |
| G7 | Dev/CI use PostgreSQL 18, lab 16 | Medium | **Verified** on `postgres:16` (16.15) with a non-superuser owner ([§5](#5-verification-report)). |
| G8 | Reset mail needs SMTP ports | Low | **Decided**: SMTP unset; reset passwords with `reset-password.js` ([§3](#3-running-it-in-the-lab)). |
| G9 | SIGTERM shutdown had no deadline | Low | **Done**: 8 s deadline, then connections closed, pool ended, exit 0; tests + mutation. |
| G10 | No `.env.example` | Low | **Done**: every variable, no values, secret format described. |
| G11 | `.dockerignore` did not exclude keys/backups | Low | **Done**: keys, certificates, backups, docs, tests, tool config excluded. |
| G14 | Memory on a shared 2 GB host | Low | **Done (procedure)**: `--memory 512m`, `NODE_OPTIONS=--max-old-space-size=384` (idle use measured at ~40 MiB). |

---

## 3. Running it in the lab

Build (on a build machine, not the server; pushing to ECR is the lab's step):

```sh
docker build --platform linux/amd64 -t mailbridge:<version> .
```

On the EC2 host, with the variables from SSM in the environment of the shell or an env file readable only by root
(never baked into the image). `IMAGE` is the ECR reference pinned by digest
(`<account>.dkr.ecr.<region>.amazonaws.com/mailbridge@sha256:…`).

```sh
# Settings shared by both commands: read-only root, no Linux capabilities, no privilege escalation, capped memory,
# a minimal init (PID 1 that forwards signals and reaps zombies).
HARDENING="--read-only --cap-drop ALL --security-opt no-new-privileges --memory 512m --init"

# 1. Create or update the schema. Idempotent; exits 0 with "No migrations to run!" when there is nothing to do.
docker run --rm $HARDENING --env-file /etc/mailbridge/app.env "$IMAGE" node dist/scripts/migrate.js

# 2. Start the app.
docker run -d --name mailbridge --restart unless-stopped $HARDENING \
  -e NODE_OPTIONS=--max-old-space-size=384 \
  --env-file /etc/mailbridge/app.env -p 3000:3000 "$IMAGE"
```

(These lines are for bash. In zsh, `$HARDENING` is not split into words; write the flags out or use an array.)

- **Order matters**: the app exits with code 1 and "Missing database table users" if step 1 has not run. Run both
  steps at every start, since the database is rebuilt each session. A systemd unit can express this as
  `ExecStartPre=` (migrate) and `ExecStart=` (app).
- **Writable paths: none.** The container runs with `--read-only` and no tmpfs; nothing in the app writes to disk.
  Logs go to stdout/stderr.
- **User**: `node` (uid 1000, gid 1000). The application files are owned by root, so the app process cannot change its
  own code even without `--read-only`.
- **Stop**: `docker stop` sends SIGTERM; the app finishes within 8 s and exits 0.
- **Nginx** must, for this app: proxy to `http://<app-host>:3000`; set `X-Forwarded-Proto $scheme` (always `https`);
  set `X-Forwarded-For $proxy_add_x_forwarded_for` (the app trusts exactly one hop, so it takes the address Nginx
  appended, not anything the client sent); pass `Host`; allow request bodies of at least 800 KB (profile photos);
  keep proxy timeouts at least 60 s (a first mailbox sync can take a while). The app sends its own security headers
  (CSP, HSTS, X-Frame-Options…) so Nginx does not need to add them.
- **ModSecurity**: the API takes JSON bodies; the CRS JSON body processor must be on. False positives are most likely on
  `POST /emails/compose` and `/emails/:id/send` (mail text). Tune those rules rather than disabling the engine.
- **Password reset** (no SMTP): run once with the user's email and a new password (≥ 16 characters) in the
  environment; existing sessions of that user are revoked:
  ```sh
  docker run --rm $HARDENING --env-file /etc/mailbridge/app.env \
    -e RESET_USER_EMAIL -e RESET_USER_PASSWORD "$IMAGE" node dist/scripts/reset-password.js
  ```
  The "Forgot password" page still exists but sends nothing in this setup (the app logs a warning).
- **Database locale**: create the `mailbridge` database with a UTF-8 `LC_CTYPE` (e.g. `en_US.UTF-8`, the default of
  the official image), or case-insensitive search only folds A–Z (see [§6](#6-decisions-and-remaining-lab-decisions)).

---

## 4. Optional: least-privilege runtime role (ADR 0008)

**What it protects.** Migration 010 makes `audit_events` insert-only with triggers. A table's owner can drop or
disable those triggers, so if the app connects as the owner, anyone holding the app's credentials (a SQL injection,
a leaked env var, a shell in the container) can erase the audit trail and change the schema. ADR 0008 therefore
splits the database identity in two:

| Role | Attributes | Owns | Used by | Needs |
|---|---|---|---|---|
| `mailbridge` (owner) | `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE` | the database and every table | the **migration** step only | `CREATE` on schema `public` (it owns the database) |
| `mailbridge_app` (runtime) | `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS` | nothing | the **app** container | the grants below |

**Grants the runtime role needs** (exactly what `deploy/db-roles.sql` applies, idempotently):

```sql
GRANT CONNECT ON DATABASE mailbridge TO mailbridge_app;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;          -- the PG15+ default, stated explicitly
GRANT USAGE ON SCHEMA public TO mailbridge_app;
-- row access only: no TRUNCATE, REFERENCES, TRIGGER, no DDL
GRANT SELECT, INSERT, UPDATE, DELETE ON
    users, sessions, login_attempts, password_resets, user_avatars,
    mail_accounts, emails, email_bodies, outgoing_messages TO mailbridge_app;
-- audit log: read and append; DELETE only gets past the guard trigger for rows beyond retention
GRANT SELECT, INSERT, DELETE ON audit_events TO mailbridge_app;
-- tables added by future migrations
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO mailbridge_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO mailbridge_app;
```

No privilege on `pgmigrations`: the runtime role can neither read nor fake the migration history.

**Order at every start** (the database is rebuilt each session):

1. **Superuser** (the lab's database setup), once per rebuild: create the owner and the database as today, and also
   the runtime role. This is the only step that needs `CREATEROLE`:
   ```sql
   CREATE ROLE mailbridge_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
       PASSWORD '<from SSM>';   -- or \password, so it never lands in a file or shell history
   ```
2. **Migrate as the owner**: the one-shot migrate container with `POSTGRES_USER=mailbridge` and the owner's password.
3. **Apply the grants as the owner**: `deploy/db-roles.sql`, after the migrations (it grants on tables that must
   exist). The image contains no `psql`, so run it from wherever `psql` is available, either
   - as the owner: `psql -h 10.0.4.10 -U mailbridge -d mailbridge -v ON_ERROR_STOP=1 -f deploy/db-roles.sql`, or
   - as the superuser acting as the owner, so `ALTER DEFAULT PRIVILEGES` is recorded for the role that creates
     future tables:
     `psql -U postgres -d mailbridge -v ON_ERROR_STOP=1 -c 'SET ROLE mailbridge' -f deploy/db-roles.sql`.

   Its `CREATE ROLE` is skipped because the role already exists, so the owner needs no `CREATEROLE`.
4. **Start the app as the runtime role**: `POSTGRES_USER=mailbridge_app` and its password.

**How the app takes two connection settings.** No code change is needed: the migrator and the app already run as
separate containers from the same image, and both read `POSTGRES_USER` / `POSTGRES_PASSWORD`. Give each container its
own values:

| Container | `POSTGRES_USER` | `POSTGRES_PASSWORD` (SSM) |
|---|---|---|
| migrate (one-shot) | `mailbridge` | owner password |
| app | `mailbridge_app` | runtime password |

That way the running app never sees the owner password. The alternative, if the lab would rather keep one env file,
is a small code change: separate `MIGRATION_POSTGRES_USER` / `MIGRATION_POSTGRES_PASSWORD` read only by `migrate.js`,
and `migrate.js` applying the grants itself, so no `psql` is needed. That puts the owner password into the app's
environment as well, which is the weaker option.

**Tested on `postgres:16`** with the image: steps 1–4 above; the app answered `/healthz` 200 and registered a user as
`mailbridge_app`; as that role, `DROP TRIGGER audit_events_guard_row` → *must be owner*, `UPDATE audit_events` →
*permission denied*, `CREATE TABLE` → *permission denied for schema public*, `SELECT FROM pgmigrations` →
*permission denied*. The same rules are covered by `tests/integration/db-roles.test.ts`.

**If the lab does not set this up**, the app runs as the owner: everything works, but the insert-only audit log
then only stops the app's own code, not someone holding its credentials.

---

## 5. Verification report

Run locally on 2026-11-02 against `chore/aws-lab-image` (second run, after the start-up log redaction and the Yarn
removal; the first run gave the same results).

**Image**

| | |
|---|---|
| Build | `docker build --platform linux/amd64 -t mailbridge:lab .` |
| Base | `node:24.21.0-bookworm-slim@sha256:d6aa754f…` (both stages), Debian 12 |
| Size | **404 MB** uncompressed (`docker image ls`), **~87 MB** gzip-compressed (`docker save … \| gzip`); the Node binary is 121 MB of that, `node_modules` 48 MB, app code < 1 MB |
| Architecture | `amd64` |
| User | `node` (uid 1000) |
| Exposed | `3000/tcp` |
| Command | `node dist/server.js`; migrate: `node dist/scripts/migrate.js` |
| Package managers / dev tooling | none: npm, npx, corepack and Yarn are removed; no TypeScript, Biome or tests. `@types/node` and `@types/pg` (type declarations only, pulled in by `pg`) remain. Removing files in a later layer hides them but does not shrink the base layer, so the size is unchanged |
| Writable paths | none (ran with `--read-only`, no tmpfs) |
| Memory | ~40 MiB idle |

**Run against `postgres:16`** (16.15, official image, SCRAM-SHA-256 for TCP, database `C.UTF-8` / `UTF8` like the
lab's). The app user was created exactly like the lab's:
`CREATE ROLE mailbridge LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE …; CREATE DATABASE mailbridge OWNER mailbridge;`
(confirmed `rolsuper=f, rolcreatedb=f, rolcreaterole=f`, password stored as SCRAM), database empty (0 tables). Every
container ran with `--read-only --cap-drop ALL --security-opt no-new-privileges --memory 512m --init`.

| Step | Result |
|---|---|
| App on the empty database | exits 1; fatal line "database unavailable; check the configuration and run the migrations", error logged as type + stack only (no message) |
| `migrate.js` (first run) | 13 migrations applied in ~1 s, exit 0 |
| Schema | 11 tables, all owned by `mailbridge`; `pg_trgm` 1.6 installed **by `mailbridge`** (`trusted = t`); `plpgsql` built in; `lower('ПОШТА') = 'пошта'` is true |
| App start | "PostgreSQL connection and schema checks successful", "server listening" |
| `GET /healthz`, `GET /health` | 200 `{"status":"ok"}`, not logged |
| Register/login with `X-Forwarded-Proto: https` | `Set-Cookie: __Host-session=…; Path=/; HttpOnly; Secure; SameSite=Lax`, HSTS sent |
| Login **without** `X-Forwarded-Proto` (first run) | 200 but **no cookie**: the G3 failure mode, now blocked at start |
| Client IP in logs (first run) | the `X-Forwarded-For` address (`10.8.0.23`), not the proxy's |
| Cross-site `POST` (first run) | 415, refused |
| Logs | no email address, password or cookie value |
| `docker stop` | SIGTERM → "shutting down" → "shut down", **~230 ms, exit 0** |
| `migrate.js` again (same DB) | "No migrations to run!", exit 0 |
| App restart | `/healthz` 200; the user created before the restart still signs in |
| Database gone at start-up | fatal line with `err` = `type`, `code`, `stack` only |
| OAuth redirect (first run) | `GET /accounts/connect/gmail` (fake client ID, Google not contacted) → `redirect_uri=https://mail.example.test/accounts/callback/gmail`, i.e. from `PUBLIC_ORIGIN` |
| Runtime role ([§4](#4-optional-least-privilege-runtime-role-adr-0008), first run) | works as described there |

**Trivy** (`aquasec/trivy:0.75.0`, the version CI pins; image scanned from a `docker save` tar):

- `--severity HIGH,CRITICAL --ignore-unfixed` (CI's gate): **0 findings, passes**.
- Including unfixed: **33 findings, 9 distinct CVEs, all in Debian 12 base packages with no fix released**
  (Debian status *will_not_fix*, *fix_deferred* or *affected*). **Accepted** (owner decision, 2026-11-02):
  - CRITICAL: CVE-2023-45853 `zlib1g` (minizip, not used by Node's own zlib; Debian *will_not_fix*);
  - HIGH: CVE-2025-69720 `ncurses`; CVE-2026-16742 `libsystemd0`/`libudev1`; CVE-2026-41992 `gzip`;
    CVE-2026-53613, CVE-2026-53615, CVE-2026-78410 `util-linux` family; CVE-2026-54369 `libacl1`; CVE-2026-9538 `perl-base`.
  - **0** in npm packages, **0** secrets found in the image.
- `trivy config` on the repository (CI's settings): Dockerfile **0 misconfigurations**.
- **Rescan on each base image bump**: whenever the `node:…-bookworm-slim` digest in the `Dockerfile` changes (Dependabot
  opens these), rebuild and run both scans above. Re-check the accepted list: drop CVEs that are gone, and decide
  on any new unfixed HIGH/CRITICAL before deploying. CI's image job already fails on any fixable HIGH/CRITICAL.

**Repository checks**: lint, typecheck, build and 75 unit tests pass (browser e2e not run: no frontend change).
Integration tests: 79 pass, 1 fails, and it also fails on `main`: the Cyrillic search case, against a local dev
database created with `LC_CTYPE=C` (see §6). Mutation entries were added for every new security check, and each is caught.

---

## 6. Decisions and remaining lab decisions

Decided by the owner on 2026-11-02:

1. **Search and the database locale: no action.** The lab database is `C.UTF-8` / `UTF8`, where `lower()` folds
   Cyrillic (verified above). The integration test fails only against a dev database created with `LC_CTYPE=C`.
   `fix/unicode-search-locale` stays a separate branch.
2. **Fatal start-up errors: done.** The base logger now uses the same `err` serializer as request logs (type, code,
   stack; never the message). The trade-off: an operator no longer sees e.g. "Missing database table users" in that
   line, only the generic text and the stack; the migrate command's own output still prints its error.
3. **Runtime role: the lab will most likely create `mailbridge_app`**; [§4](#4-optional-least-privilege-runtime-role-adr-0008) as written.
4. **Unfixed Debian CVEs: accepted**, rescan on each base image bump ([§5](#5-verification-report)).
5. **Yarn: removed** from the runtime image.

Left to the lab, no change now:

6. **Postgres TLS needs a certificate with an IP SAN.** If `POSTGRES_SSL=true` is used with `POSTGRES_HOST=10.0.4.10`,
   the server certificate must contain `IP:10.0.4.10` (or use a DNS name for the host and put that in the certificate).
7. **Registration is open by default.** Anyone who reaches the app through the VPN can create an account
   (`ALLOW_REGISTRATION=true`). For a lab with a fixed set of test users, consider `false` after creating them.
8. **Image size.** 87 MB compressed is mostly Node and Debian. Fine for a t3.small; noted only because the lab pulls it each session.
