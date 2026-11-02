# Deployment: AWS lab (single container behind Nginx/ModSecurity)

Target: one container on an Ubuntu 24.04 EC2 host (t3.small, linux/amd64), image from ECR pinned by digest,
plain HTTP on TCP 3000 behind Nginx + ModSecurity on another host (TLS ends there), reached only through a VPN at
`https://mail.<domain>`. PostgreSQL 16 on `10.0.4.10:5432`, database `mailbridge`, user `mailbridge` (owns the
database, not a superuser, cannot create roles or databases), empty at every start. Egress: TCP 443 and DNS only.
Secrets arrive as environment variables from AWS SSM.

This file is in two parts: the **inventory** (what the repo does today, no changes) and the **gaps** against the
constraints above, each with a proposed fix awaiting the owner's approval. The final report (build/run commands,
image size, verification results) is added once the image has been prepared and tested.

---

## 1. Inventory (as of `main` @ 7439118)

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
| Outgoing SMTP | nodemailer 10.2.1 (password-reset mail only, optional) | |
| Logging | pino 10.4.0 + pino-http 11.0.0, JSON lines on stdout | redaction list in `src/config/logger.ts` |
| Validation | zod 4.6.7 | env and every request |
| Config loading | dotenv 18.0.7 (`import 'dotenv/config'` in `src/config/env.ts`) | reads `./.env` if present |
| Frontend | vanilla JS/CSS/HTML in `public/`, served by Express, no CDN, strict CSP | |
| Database tested in dev/CI | PostgreSQL 18 | the lab runs **16**, see gap G7 |

### How it starts

- Build: `npm ci && npm run build` → `dist/`. Then `npm prune --omit=dev`.
- Start: `node dist/server.js` (`npm start`). The existing `Dockerfile` already does this.
- On start `src/server.ts`:
  1. parses and validates all env vars (`src/config/env.ts`); an invalid one stops the process and names the
     variable, never its value;
  2. creates the pg pool, runs `SELECT 1`, then checks that every table in `REQUIRED_TABLES` exists. **If the schema
     is missing, it logs a fatal line and exits with code 1. It does not run migrations itself.**
  3. listens on `PORT` (default 3000), all interfaces.
  4. on SIGINT/SIGTERM: stops accepting connections, closes idle keep-alive connections, waits for in-flight
     requests, then closes the pool. There is no deadline (see gap G9).
- Migrations: a separate command, `node dist/scripts/migrate.js` (`npm run migration:prod`), present in the image.
  `migrate.js down <n>` rolls back.
- Other one-shot commands in the image: `node dist/scripts/reset-password.js` (admin password reset),
  `node dist/scripts/reseal-credentials.js` (re-encrypt tokens after key rotation, see `docs/runbooks/key-rotation.md`).
- There are no background workers or timers. Mail sync runs inside HTTP requests.

### Configuration / environment variables

Everything is read once in `src/config/env.ts`. Nothing else under `src/` reads `process.env`, except the one-off
scripts (`reset-password.js` reads its own variables).

| Variable | Purpose | Required | Secret | Default / format |
|---|---|---|---|---|
| `NODE_ENV` | `production` turns on all the production checks, `__Host-` Secure cookie, HSTS | **yes** | no | `production` (also `development`, `test`) |
| `PORT` | listen port | no | no | `3000` |
| `LOG_LEVEL` | pino level | no | no | `info` (`fatal`…`trace`, `silent`) |
| `PUBLIC_ORIGIN` | public origin; builds OAuth redirect URIs and reset links; the only accepted `Origin` for state-changing requests | **yes in production**, must be `https://` | no | `https://mail.<domain>` (no path, no trailing slash) |
| `RENDER_EXTERNAL_URL` | fallback for `PUBLIC_ORIGIN` on Render.com | no | no | leave unset |
| `TRUST_PROXY` | number of proxy hops whose `X-Forwarded-For` / `-Proto` is trusted | no (but see G3) | no | `0`; must be `1` here |
| `SESSION_SECRET` | signs the session cookie; HMAC key for throttle keys | **yes** | **yes** | ≥ 32 random chars in production, different from `TOKEN_ENCRYPTION_KEY` |
| `TOKEN_ENCRYPTION_KEY` | AES-256-GCM key (via HKDF) for stored mailbox OAuth tokens | **yes in production** | **yes** | ≥ 32 random chars |
| `TOKEN_ENCRYPTION_KEY_PREVIOUS` | old key, read-only, only during key rotation | no | **yes** | unset normally |
| `POSTGRES_HOST` | DB host | **yes** | no | `10.0.4.10` |
| `POSTGRES_PORT` | DB port | **yes** | no | `5432` |
| `POSTGRES_DB` | DB name | **yes** | no | `mailbridge` |
| `POSTGRES_USER` | DB user | **yes** | no | `mailbridge` |
| `POSTGRES_PASSWORD` | DB password | **yes** | **yes** | from SSM |
| `ALLOW_REGISTRATION` | lets anyone create an app account | no | no | `true` (`true`/`false`) |
| `MICROSOFT_CLIENT_ID` | Entra app (client) ID | no (both or neither) | no* | GUID |
| `MICROSOFT_CLIENT_SECRET` | Entra client secret | no (both or neither) | **yes** | from SSM |
| `MICROSOFT_TENANT` | authority tenant | no | no | `common` |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID | no (both or neither) | no* | `….apps.googleusercontent.com` |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret | no (both or neither) | **yes** | from SSM |
| `GMAIL_ALLOWED_EMAILS` | optional invite list of app sign-in emails allowed to connect Gmail | no | no (personal data) | comma-separated, empty = everyone |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_FROM` | password-reset mail | no | no | unset here (see G8) |
| `SMTP_PASSWORD` | SMTP auth | no | **yes** | unset here |

\* Client IDs are not secret by OAuth design (they appear in the browser's authorize URL), but keeping them in SSM
next to the secret is harmless.

Not read by the app but present in the repo's example files: `POSTGRES_INITDB_ARGS`, `POSTGRES_*_NAME`,
`PGADMIN_*` (local docker compose only), `APP_DOMAIN`, `ACME_EMAIL` (Caddy only).

### Ports

- Inbound: TCP `PORT` (3000), plain HTTP. Nothing else.
- Outbound: see the host list below. PostgreSQL TCP 5432 to `10.0.4.10`.

### Database access and migrations

- `pg.Pool` (max 10, idle 30 s, connect timeout 5 s), **no TLS option** (see G6). All SQL parameterized; every query on
  user data scoped by `user_id`.
- `node-pg-migrate` with `singleTransaction: true`, `checkOrder: true`, bookkeeping table `pgmigrations`. Applied
  migrations are skipped, so running it on every start is idempotent. It takes a PostgreSQL advisory lock, so two
  starts at the same time do not both migrate.
- What the migrations need from the role:
  - `CREATE TABLE/INDEX/FUNCTION/TRIGGER` in schema `public` → the database owner has this. (PG15+ removed `CREATE`
    on `public` from `PUBLIC`; the database owner still owns `public`'s privileges because the schema is owned by
    `pg_database_owner`.)
  - **Extensions:** only **`pg_trgm`** (`012_mail_search.sql`, `CREATE EXTENSION IF NOT EXISTS pg_trgm`). `pg_trgm`
    is marked **trusted** since PostgreSQL 13, so a non-superuser with `CREATE` on the database may install it in
    PG16. It is part of `postgresql-contrib`, which the official images and the Ubuntu/RDS packages include.
  - `gen_random_uuid()` is used for UUID defaults. It is **built in since PostgreSQL 13**; `pgcrypto` and `uuid-ossp`
    are **not** used.
  - Two `plpgsql` trigger functions (audit log guard). `plpgsql` is installed in every database by default.
  - No `CREATE ROLE`, `GRANT`, `ALTER … OWNER`, `SECURITY DEFINER`, custom collations or superuser-only features.
- `deploy/db-roles.sql` (optional hardening, ADR 0008) creates a separate `mailbridge_app` role. That needs
  `CREATEROLE` and **cannot run in the lab** (see G5).

### OAuth flows

Both are authorization-code flows with PKCE (S256), a 32-byte random `state` kept in the server-side session,
compared in constant time, 10-minute expiry, and the provider name stored with it.

| | Microsoft (Graph) | Google (Gmail API) |
|---|---|---|
| Start | `GET /accounts/connect/outlook` → 302 to `login.microsoftonline.com/<tenant>/oauth2/v2.0/authorize` | `GET /accounts/connect/gmail` → 302 to `accounts.google.com/o/oauth2/v2/auth` |
| Redirect URI (today) | `${PUBLIC_ORIGIN}/accounts/callback/outlook` | `${PUBLIC_ORIGIN}/accounts/callback/gmail` |
| Scopes | `User.Read`, `Mail.ReadWrite`, `Mail.Send`, `offline_access` | `openid email profile gmail.modify gmail.send` |
| Code exchange | MSAL `acquireTokenByCode` → `login.microsoftonline.com` | `POST oauth2.googleapis.com/token` |
| Profile | `graph.microsoft.com/v1.0/me` | `openidconnect.googleapis.com/v1/userinfo` |
| Stored | MSAL token cache + home account ID, AES-256-GCM encrypted (AAD = account ID) | refresh + access token, same encryption |
| Refresh | MSAL `acquireTokenSilent` | `POST oauth2.googleapis.com/token` (`refresh_token` grant) |

The session cookie is `SameSite=Lax`, which the callback needs: the provider sends the browser back with a top-level
GET, and a `Strict` cookie would not be sent with it.

**The required single redirect URI `https://mail.<domain>/oauth/callback` does not exist today** (see G1).

### Outbound hosts at runtime (all HTTPS on 443)

| Host | Used by | When |
|---|---|---|
| `login.microsoftonline.com` | MSAL: authority metadata and instance discovery, code exchange, token refresh | Outlook connect and every token refresh |
| `graph.microsoft.com` | profile, mail sync (delta), read, send, attachments | Outlook use |
| `oauth2.googleapis.com` | code exchange, token refresh | Gmail connect and refresh |
| `openidconnect.googleapis.com` | userinfo after connect | Gmail connect |
| `gmail.googleapis.com` | mail sync, read, send, attachments | Gmail use |
| `10.0.4.10:5432` | PostgreSQL | always |
| *(SMTP host, 587/465)* | password-reset mail | **only if `SMTP_HOST` is set**: blocked by the lab egress, keep unset |

`accounts.google.com` and the Microsoft authorize page are opened by the **user's browser** (302 redirects), not by
the server. Nothing contacts a CDN, font service, telemetry or update endpoint; the frontend loads only same-origin
files (CSP `default-src 'self'`). Provider continuation URLs (Graph `@odata.nextLink`/`deltaLink`, attachment URLs)
are checked against an origin and path allowlist before they are fetched, and every outbound `fetch` uses
`redirect: 'error'` and a timeout, so the app cannot be steered to other hosts. No npm or package install at start.

### Health endpoint

`GET /health` → `200 {"status":"ok"}` after `SELECT 1` on the pool; a DB failure becomes a `500` with the standard
error body. No session or provider call, excluded from request logging, documented in `contracts/openapi.yaml`.
The `Dockerfile`'s `HEALTHCHECK` calls it. **There is no `/healthz`** (see G2).

### Logging

- JSON lines on stdout (pino). Redacted: cookies, `Authorization`, `Set-Cookie`, and any `password`, `token`,
  `accessToken`, `refreshToken`, `credentials`, `secret`, `code` field. Request lines carry method, path (no query
  string), status, request ID, `userId` and client IP.
- Error lines carry type, code and stack, never the message (driver errors can quote connection strings).
- Mail content, tokens and passwords are never logged. Email addresses go to the `audit_events` **table**, not the logs.
  The only log line with an address and a reset link is the development-only "mail disabled" fallback, which is off when
  `NODE_ENV=production`.
- `migrate.js` prints `error.message` on failure, so a pg connection error message could appear (it does not contain
  the password: pg does not echo it).

### Existing packaging

- `Dockerfile`: two stages, `node:24.21.0-bookworm-slim` pinned by digest, `npm ci` → build → `npm prune --omit=dev`,
  runtime runs `apt-get upgrade`, removes npm/npx/corepack, copies `node_modules`, `dist`, `public`, `database`,
  runs as `node` (uid 1000), `EXPOSE 3000`, `HEALTHCHECK` on `/health`, `CMD ["node","dist/server.js"]`.
- `.dockerignore`: excludes `.git`, `.github`, `node_modules`, `dist`, `.env`, `.env.*`, `.env-example`, tests, docs,
  coverage, logs.
- `compose.production.yaml` (Contabo/Caddy design) already runs the app `read_only: true` with `tmpfs: /tmp`,
  `cap_drop: ALL`, `no-new-privileges`, `init: true`.
- Env examples: `.env-example` (development) and `.env.production.example` (Caddy design). There is no `.env.example`.

---

## 2. Gaps against the lab constraints (proposed, awaiting approval)

Severity: **High** = the deployment does not work or violates a hard constraint · **Medium** = works but weaker or
fragile · **Low** = polish / documentation.

| # | Gap | Severity | Proposed fix |
|---|---|---|---|
| G1 | OAuth redirect URIs are `/accounts/callback/{outlook,gmail}`; the lab registers one URI, `/oauth/callback`. | High | Add `GET /oauth/callback`: it takes the provider from the pending OAuth state already in the session (it is stored there today), then runs the existing callback handler. Both providers then use `${PUBLIC_ORIGIN}/oauth/callback` as their `redirect_uri`. The old paths keep working. Contract change in `openapi.yaml` first. |
| G2 | Health endpoint is `/health`, not `/healthz`. | Low | Add `GET /healthz` as an alias of `/health` (same DB check, not logged), contract updated, `HEALTHCHECK` uses it. Alternative: keep `/health` only and point the lab's checks at it. |
| G3 | `TRUST_PROXY` defaults to `0`. Behind Nginx that makes `req.secure` false, so express-session **silently refuses to set the `Secure` `__Host-session` cookie** (sign-in appears to work, then nothing is signed in), and throttling sees only the Nginx IP. | High (config) / Medium (code) | Set `TRUST_PROXY=1` in the lab env. Also make production refuse to start with `TRUST_PROXY=0`, since the app never ends TLS itself. |
| G4 | Schema is not created at start; the app exits if the DB is empty. | High (procedure) | The image already has the one-shot command: run `node dist/scripts/migrate.js` (same image, same env) before the app on every start. Optional: a `MIGRATE_ON_START=true` switch so a single `docker run` does both. Recommended: keep the one-shot command (simple, and failures are visible as their own step). |
| G5 | ADR 0008's least-privilege setup (app connects as `mailbridge_app`, not the table owner) cannot be used: the lab user cannot create roles. The app's credentials therefore own the tables and could drop the audit-log guard triggers. | Medium (accepted risk) | No code change. Document as an accepted lab risk. If the DB admin can create a second role, `deploy/db-roles.sql` works unchanged. |
| G6 | No TLS between app and PostgreSQL. SCRAM protects the password, but mail content and session data cross the network in clear. | Medium | Optional `POSTGRES_SSL` (`disable` / `require` / `verify-full`) plus `POSTGRES_SSL_CA` (PEM in an env var) on both the pool and the migrator. Needs a server certificate on 10.0.4.10. |
| G7 | Dev and CI test on PostgreSQL 18; the lab runs 16. | Medium until verified | Verify in step 4 with `postgres:16` and a non-superuser owner. Migrations use only PG13+ features (as listed above), so this is expected to pass. |
| G8 | Password-reset mail needs SMTP (587/465), which the egress blocks. With `SMTP_HOST` unset, production logs a warning and the user gets no mail. | Low | Keep SMTP unset and use the admin script `reset-password.js` for resets. Optionally hide "Forgot password". Owner decision. |
| G9 | SIGTERM shutdown has no deadline. A Gmail retry backoff can wait 30 s or more, and Docker sends SIGKILL after 10 s, so `pool.end()` may never run. | Low | After SIGTERM, wait up to 8 s for in-flight requests, then `closeAllConnections()`, end the pool and exit with code 0. Run with `--init`. |
| G10 | `.env.example` does not exist (only `.env-example` and `.env.production.example`, both for other setups). | Low | Add `.env.example` for this lab: every variable, no values, comments marking secrets. |
| G11 | `.dockerignore` does not exclude private keys or backups by pattern (`*.pem`, `*.key`, `backups/`), and the build context sends `deploy/`, `contracts/`, `prompt-da-se-stavi.txt`… (the last one is caught by `*.txt`). | Low | Add `*.pem *.key *.p12 *.pfx id_* backups deploy contracts *.md` (keeping what the build needs). |
| G12 | Runtime stage runs `apt-get upgrade` at build time: builds are not reproducible from the digest alone. | Low (trade-off) | Keep it (it is what removes fixed Debian CVEs); the ECR digest is what pins the deployed artefact. Note it. |
| G13 | `dotenv` loads `./.env` if one exists. No `.env` is in the image, but a mounted one would override nothing and add confusion. | Low | Leave as is; document that the lab passes env vars only. |
| G14 | Memory: t3.small with 2 GB shared with Docker and Wazuh. | Low | Run with `--memory=512m` and `NODE_OPTIONS=--max-old-space-size=384`; document. |

Open decisions for the owner are collected at the end of the final report.
