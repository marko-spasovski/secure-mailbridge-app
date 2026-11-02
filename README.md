<div align="center">

<img src="public/assets/logo-dark.svg" width="72" alt="">

# Mailbridge

**Outlook and Gmail in one inbox.**

Connect any number of mailboxes and read them together, with each account still one click away in the sidebar.

[![CI](https://github.com/rossiko22/Mailbridge/actions/workflows/ci.yml/badge.svg)](https://github.com/rossiko22/Mailbridge/actions/workflows/ci.yml)
[![CodeQL](https://github.com/rossiko22/Mailbridge/actions/workflows/codeql.yml/badge.svg)](https://github.com/rossiko22/Mailbridge/actions/workflows/codeql.yml)
![Node.js 24](https://img.shields.io/badge/node-24-5fa04e?logo=nodedotjs&logoColor=white)
![TypeScript strict](https://img.shields.io/badge/typescript-strict-3178c6?logo=typescript&logoColor=white)
![PostgreSQL 18](https://img.shields.io/badge/postgresql-18-4169e1?logo=postgresql&logoColor=white)

![The combined inbox with a message open](docs/screenshots/reader.png)

</div>

## Contents

- [What it does](#what-it-does)
- [Screenshots](#screenshots)
- [How it works](#how-it-works)
- [Security](#security)
- [Quick start](#quick-start)
- [Connecting real mailboxes](#connecting-real-mailboxes)
- [Configuration](#configuration)
- [Testing](#testing)
- [CI/CD](#cicd)
- [Deployment](#deployment)
- [Project layout](#project-layout)

## What it does

- **One inbox for every account.** Mail from all connected Outlook and Gmail accounts appears in a single list, colour-coded by mailbox, with per-account views, an unread filter, search and sorting.
- **Inbox, Sent and Junk.** Each folder combines every account, like the inbox. Sent mail is listed by recipient; junk mail opens with a warning, and its images stay off like everywhere else.
- **Read mail safely.** Message bodies render in a sandboxed frame that cannot run scripts, and remote images stay off until you ask for them.
- **Reply, forward and compose** from any connected account. Read state is written back to the provider, so Outlook and Gmail stay in step.
- **Attachments and export.** Download attachments, or save any message as an `.eml` file.
- **Accounts and profile.** Sign up, sign in, reset a forgotten password by email, change your name and photo, and switch between light and dark themes.
- **Recent activity.** Settings lists the sign-ins, password changes, mailbox connections and sends on your account, with time, device and address, so anything that was not you stands out.
- **Works without any setup.** A seeded demo user with two demo mailboxes lets you try the whole interface before registering an OAuth app.

## Screenshots

| Light | Dark |
| --- | --- |
| ![Inbox in the light theme](docs/screenshots/inbox.png) | ![Inbox in the dark theme](docs/screenshots/inbox-dark.png) |
| ![Settings page listing connected accounts](docs/screenshots/settings.png) | ![Sign-in page](docs/screenshots/sign-in.png) |

<p align="center">
  <img src="docs/screenshots/mobile-list.png" width="260" alt="Message list on a phone">
  &nbsp;&nbsp;
  <img src="docs/screenshots/mobile-reader.png" width="260" alt="Message reader on a phone">
</p>

These pictures are produced by the browser tests, so they always show the current interface. To refresh them:

```sh
SCREENSHOT_DIR=docs/screenshots npm run test:e2e
```

## How it works

```mermaid
flowchart LR
    Browser["Browser<br>plain HTML, CSS and JS"]

    subgraph Server["Node.js 24 · Express 5 · TypeScript"]
        direction TB
        Guard["Security headers · same-site JSON check<br>sessions · sign-in throttling"]
        Modules["auth · users · accounts · emails"]
        Providers["Mail providers<br>one interface, two implementations"]
        Guard --> Modules --> Providers
    end

    DB[("PostgreSQL<br>users · sessions · accounts<br>cached mail · send log")]
    Graph["Microsoft Graph"]
    Gmail["Gmail API"]

    Browser <--> Guard
    Modules <--> DB
    Providers <--> Graph
    Providers <--> Gmail
```

- **No front-end build step.** The interface is hand-written HTML, CSS and JavaScript served as static files.
- **One provider interface.** Outlook and Gmail each implement the same small `MailClient` contract (sync, body, attachments, send, mark read), so the rest of the app never asks which provider it is talking to.
- **Incremental sync.** The first sync loads the last 90 days of the Inbox, Sent and Junk folders. After that, only changes are fetched: Graph delta links for Outlook and history IDs for Gmail. An expired checkpoint rebuilds itself.
- **Gmail quota aware.** Gmail allows 6,000 quota units per mailbox per minute. The client budgets its requests, and when Google reports the minute is used up it waits for the next one instead of failing.
- **Sends are never duplicated.** Every send carries a request ID that is recorded before the provider is called. A retry of an accepted request is answered from the record, and an uncertain outcome is reported as uncertain rather than retried.
- **No database lock waits on the network.** A sync claims its account with a short lease, and token refreshes are saved with compare-and-swap, so a slow provider never ties up a database connection.
- **Fast at any size.** The inbox pages by cursor (keyset), straight from an index in inbox order, and search uses full-text and trigram indexes. On 100,000 saved messages, a page takes under a millisecond and a search under 25 ms.
- **One contract.** [`contracts/openapi.yaml`](contracts/openapi.yaml) describes every endpoint; requests are validated with Zod against the same rules, and every error has a stable `code`. See [docs/architecture.md](docs/architecture.md).

## Security

| Area | What is done |
| --- | --- |
| Passwords | Argon2id (128 MiB, 3 passes). Reset tokens are single-use, expire after 30 minutes, are stored only as a hash and travel in the URL fragment. |
| Sessions | Server-side sessions in PostgreSQL. The cookie is `HttpOnly`, `SameSite=Lax`, and in production `Secure` with the `__Host-` prefix. The session ID is replaced on sign-in, a session ends after 8 idle hours and at most 7 days after sign-in, and changing or resetting a password signs out every session. |
| Request forgery | Every state-changing request must be same-site `application/json`; cross-site and foreign-origin requests are refused. |
| Brute force | Sign-in, registration and reset attempts are counted per address and per account, and password changes and sends per signed-in person. An unknown address is refused as slowly as a wrong password. Counter keys are HMAC-hashed, so the table stores no email or IP addresses. |
| OAuth | Authorization code flow with PKCE and a single-use `state`, compared in constant time. Tokens are encrypted with AES-256-GCM, bound to their account row, and never reach the browser. The encryption key can be rotated without anyone reconnecting ([runbook](docs/runbooks/key-rotation.md)). |
| Input | Every request body, query and path parameter is checked by a Zod schema; bodies are strict, so unknown fields are refused. |
| Mail content | HTML is sanitized and shown in a sandboxed frame under its own Content-Security-Policy. Sync cursors are validated so a stored URL can never send a token to another host. |
| Data isolation | Every query is scoped to the signed-in user. Another person's mail and accounts answer `404`. |
| Audit trail | Sign-ins and failures, password changes and resets, mailbox connections, sends, downloads and refused requests are recorded with time, IP address, browser and request ID, and kept for 90 days. The log never holds mail content, recipients, passwords or tokens, and an attempt on an unknown address is stored without the address. The database itself refuses to change or truncate audit rows, and the app can run as a role that cannot switch that guard off ([`deploy/db-roles.sql`](deploy/db-roles.sql)). |
| Logs | One JSON line per request with a request ID, path (never the query string), status, user and client IP. Cookies, passwords and tokens are redacted, and error messages are never logged. |
| Headers | Strict Content-Security-Policy, `X-Frame-Options: DENY`, `nosniff`, `no-referrer`, and HSTS in production. |
| Container | Runs as a non-root user on a read-only filesystem with all capabilities dropped. |

Each row above is exercised by the test suite described under [Testing](#testing). [SECURITY.md](SECURITY.md) maps these protections to the OWASP Top 10, lists the known limits and says how to report a problem.

## Quick start

You need Node.js 24 and Docker.

```sh
npm ci
cp .env-example .env
docker compose up -d postgres
npm run migration
npm run seed        # demo user demo@example.test / Demo-Password-123! with two demo mailboxes
npm run dev         # http://localhost:3000
```

Without OAuth credentials the demo mailboxes still work; the Connect buttons stay disabled until a provider is configured. Password reset emails are caught by Mailpit: run `docker compose up -d mailpit` and read them at http://localhost:8025. Nothing is delivered to real inboxes. With `SMTP_HOST` empty, reset links are printed to the server log instead (development only).

To browse the database, run `docker compose up -d pgadmin` and open http://localhost:5050. Sign in with `PGADMIN_DEFAULT_EMAIL` / `PGADMIN_DEFAULT_PASSWORD` from `.env`; the Mailbridge server is already listed and asks for `POSTGRES_PASSWORD`.

## Connecting real mailboxes

Register an app with each provider and set the redirect URIs:

| Provider | Redirect URI | Env vars | Scopes |
| --- | --- | --- | --- |
| Microsoft (Entra app registration) | `<PUBLIC_ORIGIN>/accounts/callback/outlook` | `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_TENANT` | `User.Read Mail.ReadWrite Mail.Send offline_access` |
| Google (Cloud console, OAuth client "Web") | `<PUBLIC_ORIGIN>/accounts/callback/gmail` | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Gmail API: `gmail.modify` and `gmail.send` |

Notes:

- `MICROSOFT_TENANT` must match the app registration's supported account types: `common` for work, school and personal accounts, `consumers` for personal accounts only, or a tenant ID for one organisation.
- `GMAIL_ALLOWED_EMAILS=a@x.com,b@y.com` limits the Gmail option to those app users, which fits an unverified Google app limited to test users. Outlook stays open to everyone.
- Gmail's mail scopes are *restricted*. While the Google app is in "Testing", only listed test users can connect and tokens expire after 7 days; public use needs Google's verification.
- A large Gmail inbox syncs at roughly 270 messages per minute because of Google's per-mailbox quota.
- Gmail forwards do not include the original attachments.
- Migration `008_unified_mailboxes.sql` replaces the old ticket schema and **deletes previously cached emails** (they are re-synced from the provider). It is not reversible.

## Configuration

All settings are environment variables; see [.env-example](.env-example) for development, [.env.production.example](.env.production.example) for the Caddy setup and [.env.example](.env.example) for every variable with its format (used by the [AWS lab deployment](docs/deployment.md)).

| Variable | Purpose |
| --- | --- |
| `PUBLIC_ORIGIN` | Public address of the app. Required in production, where it must be HTTPS. |
| `SESSION_SECRET`, `TOKEN_ENCRYPTION_KEY` | Sign sessions and encrypt stored mailbox credentials. At least 32 characters each and different from each other in production. |
| `TOKEN_ENCRYPTION_KEY_PREVIOUS` | Only while rotating the encryption key; see [the runbook](docs/runbooks/key-rotation.md). |
| `TRUST_PROXY` | How many reverse proxies may set `X-Forwarded-For` / `X-Forwarded-Proto` (`1` behind Caddy or Nginx). Decides the client IP used by throttling, logs and the audit trail, and lets the Secure session cookie be set. Production requires at least `1`. |
| `LOG_LEVEL` | `info` by default; `debug`, `warn`, `error` or `silent`. |
| `ALLOW_REGISTRATION` | Set to `false` to stop new sign-ups. |
| `MICROSOFT_*`, `GOOGLE_*` | OAuth app credentials. A provider without them is simply not offered. |
| `GMAIL_ALLOWED_EMAILS` | Optional invite list for the Gmail option. |
| `SMTP_*` | Outgoing mail for password resets. |
| `POSTGRES_*` | Database connection. `POSTGRES_SSL=true` turns on TLS with full certificate verification; `POSTGRES_SSL_CA` takes the PEM of a private CA. |
| `PGADMIN_*` | Local pgAdmin sign-in and port (development only). |

## Testing

Everything runs on Node's built-in test runner with no extra test framework.

| Layer | Command | Needs | What it covers |
| --- | --- | --- | --- |
| Unit | `npm test` | nothing | Gmail and Outlook clients against recorded responses, quota budgeting, cursor validation, MIME handling, HTML sanitizing, credential encryption and key rotation, validation rules, configuration rules |
| Integration | `npm run test:integration` | PostgreSQL | The real app over HTTP against a real database. Driven by the contract: every endpoint answers `401` without a session, `404` for another person's data and `400` with the failing fields for invalid input. Also sessions, throttling, password reset, OAuth, sync leases, send idempotency, search, paging, logs, the audit guard and the least-privilege database role |
| Browser | `npm run test:e2e` and `npm run test:e2e:firefox` | PostgreSQL, Chromium/Firefox | Sign-in, the inbox, Sent and Junk, reading, filters, search, paging, settings, sign-out, keyboard-only use, Back after sign-out, and no sideways scrolling at phone width. Any console error or Content-Security-Policy violation fails the test |
| Mutation | `npm run test:mutation` | PostgreSQL | Plants 22 deliberate bugs in security- and logic-critical code, one at a time, and requires the tests to catch each one ([tests/mutation](tests/mutation)) |

```sh
npm run check            # lint, typecheck (source, tests, browser scripts), unit tests, build
npm run test:coverage    # unit + integration with coverage thresholds
npm run test:all         # unit, integration and both browsers
npx playwright install chromium firefox   # once, before the first browser run
```

- **A separate database.** Integration and browser tests use `<POSTGRES_DB>_test`, created and migrated automatically, so they never touch development data.
- **No network.** Google and Microsoft are replaced by in-process stand-ins; an unexpected outbound request fails the test.
- **Coverage is enforced.** `test:coverage` fails below 90% of lines, 75% of branches or 85% of functions. It currently reports 95%, 87% and 92%.
- **Migrations are tested both ways.** CI rolls back every migration after 008 and applies it again (`npm run migration -- down <n>`).

## CI/CD

Every pull request and every push to `main` runs [`.github/workflows/ci.yml`](.github/workflows/ci.yml). Every action is pinned to a commit SHA and every image to a digest.

| Job | What it checks |
| --- | --- |
| Lint, types, unit tests, build | Biome, strict TypeScript over source, tests and browser scripts, the unit suite, and a production build |
| Integration tests and coverage | Migrations run twice, roll back and run again; then the unit and integration suites under the coverage thresholds |
| Browser tests | The Playwright suite in Chromium and in Firefox, with screenshots kept for 14 days |
| Mutation tests | Every planted bug must be caught, and the working tree must be unchanged afterwards |
| Dependency audit | `npm audit` for production dependencies, plus a review of dependencies added by a pull request |
| Secret scan | gitleaks over the full history; reviewed false positives are listed in `.gitleaksignore` |
| Static analysis | Semgrep with explicit rule packs (JavaScript, TypeScript, OWASP Top 10, secrets, Dockerfile) |
| Workflow lint | actionlint |
| API contract lint | Redocly (`recommended-strict`) over `contracts/openapi.yaml` |
| Configuration scan | Trivy over the Dockerfile |
| Build, scan and smoke-test the image | Builds the image, scans it with Trivy, checks it does not run as root, starts it read-only in production mode and checks `/health`, the security headers and the session cookie |
| Publish image | Only when the repository variable `PUBLISH_IMAGE` is `true` (off by default), on `main` and version tags, after every job above passes: pushes `ghcr.io/<owner>/<repo>` with a signed build provenance attestation |
| GitHub release | On a `v*` tag, creates a release with generated notes |

Alongside it:

- **CodeQL** ([`codeql.yml`](.github/workflows/codeql.yml)) scans the code for security problems on every push, pull request and weekly.
- **Dependabot** ([`dependabot.yml`](.github/dependabot.yml)) opens weekly grouped updates for npm packages, GitHub Actions, the Docker base image and the compose images, each at least seven days after its release.

To cut a release:

```sh
git tag v1.1.0
git push origin v1.1.0
```

That publishes the image as `1.1.0`, `1.1` and by commit, and creates the GitHub release. Pushes to `main` publish `latest`.

## Deployment

[`compose.production.yaml`](compose.production.yaml) runs the app, PostgreSQL and Caddy (automatic HTTPS) on one host.

```sh
cp .env.production.example .env.production      # fill in secrets, domain and OAuth apps
docker compose --env-file .env.production -f compose.production.yaml up -d --build
docker compose --env-file .env.production -f compose.production.yaml exec app node dist/scripts/migrate.js
```

- The compose file builds the image on the host. To run the image published by CI instead, set the `app` service's `image` to `ghcr.io/rossiko22/mailbridge:latest` and remove `build`.
- [`deploy/backup.sh`](deploy/backup.sh) writes a database dump to `backups/`; keep copies off the host.
- [`deploy/smoke-test.sh`](deploy/smoke-test.sh) is the same check CI runs against the image.
- `GET /healthz` (or `/health`) answers 200 when the app and its database are up; the image's `HEALTHCHECK` uses it.
- [docs/deployment.md](docs/deployment.md) covers running the image behind a separate TLS proxy (the AWS lab): inventory, env vars, outbound hosts, migrations, the least-privilege database role and a verification report.
- If someone is locked out, `node dist/scripts/reset-password.js` (run inside the app container) sets a new password from the server. It reads `RESET_USER_EMAIL` and `RESET_USER_PASSWORD` (at least 16 characters) from the environment.

## Project layout

```
src/
  app.ts, server.ts        Express wiring and startup
  config/                  configuration schema, database pool, logger
  http/                    error codes and input validation
  middleware/              security headers, same-site check, sessions, throttling, errors
  modules/
    auth/                  sign-in, registration, password reset
    audit/                 the security event log
    users/                 profile and photo
    accounts/              connected mailboxes and the OAuth callback
    emails/                listing, reading, sending, export, HTML sanitizing
  integrations/
    mail/                  the provider contract shared by both mail services
    gmail/, outlook/       the two implementations
  security/                password hashing and credential encryption
  scripts/                 migrations, demo data, admin tools
public/                    the interface: HTML, CSS, JavaScript, icons
types/                     type declarations for the browser scripts
contracts/                 the OpenAPI contract
database/migrations/       SQL migrations
tests/                     unit tests, plus integration/, e2e/, mutation/ and support/
deploy/                    Caddy config, database roles, backup and smoke-test scripts
docs/                      architecture, decisions (adr/), runbooks, analysis
```
