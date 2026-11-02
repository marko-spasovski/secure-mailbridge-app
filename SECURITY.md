# Security

## Reporting a problem

Please do not open a public issue for a security problem. Use **Security → Report a vulnerability** on the GitHub repository, which opens a private report to the maintainer. Include what you did, what happened and what you expected. You should get a first answer within a week.

Only the latest commit on `main` is supported.

## How the app is protected

The table follows the OWASP Top 10 (2021). Each line names where the protection lives; the integration tests in `tests/integration/` exercise them against a real database.

| Risk | Protection |
| --- | --- |
| A01 Broken access control | Every data route needs a session (`auth.middleware.ts`). Every mail and account query is scoped to the signed-in user, so another person's records answer `404`; tests derived from the API contract check this for every operation. State-changing requests must be same-site JSON (`json.middleware.ts`), which blocks cross-site request forgery. |
| A02 Cryptographic failures | Passwords are hashed with Argon2id. Mailbox tokens are encrypted with AES-256-GCM, bound to their account row, with a full-length authentication tag and a key ID so the key can be rotated (`token-vault.ts`, [runbook](docs/runbooks/key-rotation.md)). Password-reset mail requires TLS in production. Reset tokens are random, single-use and stored only as a hash. Production refuses to start with short secrets, a non-HTTPS origin or without a trusted proxy hop (the proxy ends TLS), and sends HSTS. TLS to PostgreSQL is optional and, when on, always verifies the server certificate and host name. |
| A03 Injection | All SQL is parameterized, and every request input is checked by a strict Zod schema (unknown fields are refused). Mail HTML is sanitized to a small allowlist and shown in a sandboxed frame that cannot run scripts. Junk mail, where phishing lands, gets the same frame plus a warning about its links and attachments. Outgoing mail headers reject line breaks. The interface builds pages with `textContent`, under a Content-Security-Policy that allows no inline script. |
| A04 Insecure design | Sends are recorded before the provider is called, so a retry cannot send twice. Sign-in and password reset answer the same way whether or not an account exists. Limits apply per address, per account and per signed-in person. |
| A05 Security misconfiguration | Strict security headers on every response (`security.middleware.ts`). The container runs as a non-root user on a read-only filesystem with no capabilities. The development database and tools listen on `127.0.0.1` only. Error responses carry a stable code and never include internals. The app can run as a database role that cannot change the schema (`deploy/db-roles.sql`). |
| A06 Vulnerable and outdated components | `npm audit` and a dependency review run on every pull request; CodeQL, Semgrep, gitleaks (full history) and Trivy (configuration and image) run in CI; Dependabot proposes updates weekly, a week after each release. Every CI action and image is pinned by SHA or digest. |
| A07 Identification and authentication failures | Sessions live on the server, with `HttpOnly`, `SameSite=Lax` cookies that are `Secure` and `__Host-` prefixed in production. The session ID is replaced at sign-in. A session ends after 8 idle hours and at most 7 days after sign-in. Changing or resetting a password signs out every session. Refusing an unknown address takes as long as refusing a wrong password. |
| A08 Software and data integrity failures | Dependencies install from the lockfile (`npm ci`). The published image carries a signed build provenance attestation and contains no package manager. OAuth uses PKCE and a single-use `state`, compared in constant time. |
| A09 Security logging and monitoring failures | Sign-ins, failures, password changes, mailbox connections, sends, downloads and refused requests are written to `audit_events` with time, address, browser and request ID, kept for 90 days, and shown to each person under Settings → Recent activity. The database refuses to change or truncate audit rows (migration 010). Request logs are JSON lines with request IDs; cookies, passwords and tokens are redacted and query strings are never logged. |
| A10 Server-side request forgery | The server only calls fixed Google and Microsoft hosts. Stored sync cursors are validated before use (each Outlook folder's link must point at that folder's Graph delta, and all are checked before the first request), redirects are refused, and downloads are size-limited. Remote images in mail are loaded by the browser, never by the server. |

## Known limits

These are deliberate trade-offs or work not yet done.

- **No two-factor sign-in.** A password is the only factor.
- **No email verification at sign-up.** Anyone can register with an address they do not own; the real owner can take the account over with a password reset.
- **Registration reveals whether an address is taken.** Sign-in and password reset do not.
- **Sign-in throttling can lock a person out** for 15 minutes if someone else keeps guessing their password.
- **Passwords are checked for length only**, not against lists of breached passwords.
- **No alerting yet.** Events are recorded but nothing notifies an operator of a spike in failures (planned for the server-security phase).
- **Deleting an account erases its audit history** (the right to erasure). Someone who can delete a victim's account can therefore remove that account's trail.
