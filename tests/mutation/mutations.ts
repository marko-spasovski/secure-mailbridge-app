// Deliberate bugs in security- and logic-critical code. Each one must make at least one of its tests fail.
// `find` must occur exactly once in `file`; `tests` are the test files expected to catch it (kept small for speed).

export interface Mutation {
    name: string;
    file: string;
    find: string;
    replace: string;
    tests: string[];
}

const UNIT = (name: string) => `tests/${name}.test.ts`;
const INTEGRATION = (name: string) => `tests/integration/${name}.test.ts`;

export const mutations: Mutation[] = [
    // Cryptography
    {
        name: 'token vault stops binding credentials to their account (AAD)',
        file: 'src/security/token-vault.ts',
        find: '    decipher.setAAD(Buffer.from(context));\n',
        replace: '',
        tests: [UNIT('token-vault')],
    },
    {
        name: 'token vault encrypts without associated data',
        file: 'src/security/token-vault.ts',
        find: '            cipher.setAAD(Buffer.from(context));\n',
        replace: '',
        tests: [UNIT('token-vault')],
    },
    // Cross-site request forgery
    {
        name: 'same-site check ignores Sec-Fetch-Site',
        file: 'src/middleware/json.middleware.ts',
        find: "req.get('Sec-Fetch-Site') === 'cross-site'",
        replace: "req.get('Sec-Fetch-Site') === 'never-sent'",
        tests: [INTEGRATION('security')],
    },
    {
        name: 'same-site check ignores a foreign Origin',
        file: 'src/middleware/json.middleware.ts',
        find: '(sentOrigin && sentOrigin !== origin)',
        replace: 'false',
        tests: [INTEGRATION('security')],
    },
    // Sessions and sign-in
    {
        name: 'sessions never reach their maximum age',
        file: 'src/middleware/auth.middleware.ts',
        find: 'now() - req.session.signedInAt > MAX_SESSION_AGE',
        replace: 'false',
        tests: [INTEGRATION('security')],
    },
    {
        name: 'deactivated accounts can sign in',
        file: 'src/modules/users/users.service.ts',
        find: 'if (!passwordMatches || !user.isActive) {',
        replace: 'if (!passwordMatches) {',
        tests: [UNIT('user-service'), INTEGRATION('auth'), INTEGRATION('security')],
    },
    {
        name: 'a reset link works for a deactivated account',
        file: 'src/modules/users/users.repository.ts',
        find: ' AND u.user_id = r.user_id AND u.is_active',
        replace: ' AND u.user_id = r.user_id',
        tests: [INTEGRATION('auth')],
    },
    {
        name: 'throttle never blocks',
        file: 'src/middleware/security.middleware.ts',
        find: 'if (result.rows[0].attempts > limit) {',
        replace: 'if (result.rows[0].attempts > limit * 1000) {',
        tests: [INTEGRATION('auth'), INTEGRATION('security')],
    },
    {
        name: 'production session cookie loses the __Host- prefix',
        file: 'src/middleware/session.middleware.ts',
        find: "{ name: '__Host-session', secure: true }",
        replace: "{ name: 'session', secure: true }",
        tests: [UNIT('session')],
    },
    {
        name: 'OAuth state is not compared',
        file: 'src/modules/accounts/accounts.routes.ts',
        find: 'given !== undefined && given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected))',
        replace: 'given !== undefined',
        tests: [INTEGRATION('mail'), INTEGRATION('audit')],
    },
    // Access control: another person's data must stay invisible
    {
        name: 'one email can be read by anyone',
        file: 'src/modules/emails/emails.repository.ts',
        find: 'WHERE e.email_id = $1 AND a.user_id = $2`',
        replace: 'WHERE e.email_id = $1 AND $2::uuid IS NOT NULL`',
        tests: [INTEGRATION('contract')],
    },
    {
        name: 'the inbox lists everyone’s mail',
        file: 'src/modules/emails/emails.repository.ts',
        find: 'WHERE a.user_id = $1 AND ($2::uuid IS NULL OR a.account_id = $2)',
        replace: 'WHERE $1::uuid IS NOT NULL AND ($2::uuid IS NULL OR a.account_id = $2)',
        tests: [INTEGRATION('mail')],
    },
    {
        name: 'one account can be read by anyone',
        file: 'src/modules/accounts/accounts.repository.ts',
        find: 'WHERE a.user_id = $1 AND a.account_id = $2`',
        replace: 'WHERE $1::uuid IS NOT NULL AND a.account_id = $2`',
        tests: [INTEGRATION('contract')],
    },
    {
        name: 'anyone can remove an account',
        file: 'src/modules/accounts/accounts.repository.ts',
        find: "'DELETE FROM mail_accounts WHERE user_id=$1 AND account_id=$2'",
        replace: "'DELETE FROM mail_accounts WHERE $1::uuid IS NOT NULL AND account_id=$2'",
        tests: [INTEGRATION('mail'), INTEGRATION('contract')],
    },
    // Sending
    {
        name: 'a send request ID can be reused for different content',
        file: 'src/modules/emails/emails.repository.ts',
        find: "if (rows[0]?.same && rows[0].state === 'accepted') return false;",
        replace: "if (rows[0]?.state === 'accepted') return false;",
        tests: [INTEGRATION('mail')],
    },
    {
        name: 'a subject may contain line breaks (header injection)',
        file: 'src/modules/emails/emails.schemas.ts',
        find: ".regex(/^[^\\r\\n]*$/, { error: 'A subject cannot contain line breaks.' })",
        replace: ".regex(/^[\\s\\S]*$/, { error: 'A subject cannot contain line breaks.' })",
        tests: [INTEGRATION('validation')],
    },
    // Reading mail safely
    {
        // (Plain-HTTP images are blocked twice, by the scheme allowlist and by this transform, so removing only one
        // of the two cannot be observed; that redundancy is deliberate.)
        name: 'remote images load without the person opting in',
        file: 'src/modules/emails/presentation.ts',
        find: 'if (!images || !remote)',
        replace: 'if (!remote)',
        tests: [UNIT('presentation')],
    },
    {
        name: 'the mail reader may run scripts',
        file: 'src/modules/emails/presentation.ts',
        find: "default-src 'none'; script-src 'none';",
        replace: "default-src 'none'; script-src 'self';",
        tests: [UNIT('presentation'), INTEGRATION('mail')],
    },
    // Input that reaches SQL
    {
        name: 'search stops escaping LIKE wildcards',
        file: 'src/modules/emails/emails.repository.ts',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: this is the source text to find, not a template.
        find: 'text.replace(/[\\\\%_]/g, match => `\\\\${match}`)',
        replace: 'text',
        tests: [INTEGRATION('mail')],
    },
    {
        name: 'a page cursor from another sort order is accepted',
        file: 'src/modules/emails/emails.routes.ts',
        find: 'if (query.cursor && after?.sort !== query.sort)',
        replace: 'if (query.cursor && !after)',
        tests: [INTEGRATION('mail')],
    },
    // Mail folders
    {
        name: 'the mail list ignores the folder',
        file: 'src/modules/emails/emails.repository.ts',
        find: 'WHERE e.account_id = a.account_id AND e.folder = $8',
        replace: 'WHERE e.account_id = a.account_id AND $8::text IS NOT NULL',
        tests: [INTEGRATION('mail')],
    },
    {
        name: 'a removal from one folder deletes the copy that moved to another',
        file: 'src/modules/emails/emails.repository.ts',
        find: 'AND ($3::text IS NULL OR folder=$3)',
        replace: 'AND ($3::text IS NULL OR TRUE)',
        tests: [INTEGRATION('mail')],
    },
    {
        name: 'an Outlook checkpoint may read another folder',
        file: 'src/integrations/outlook/graph.ts',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: this is the source text to find, not a template.
        find: '/mailFolders/${GRAPH_FOLDERS[folder]}/messages/delta$`',
        replace: '/mailFolders/(?:inbox|sentitems|junkemail|drafts)/messages/delta$`',
        tests: [UNIT('outlook')],
    },
    {
        name: 'trashed Gmail mail stays visible in Sent',
        file: 'src/integrations/gmail/api.ts',
        find: "    if (labels.includes('TRASH')) return null;\n",
        replace: '',
        tests: [UNIT('gmail'), INTEGRATION('mail')],
    },
    {
        name: 'a sent message can be replied to (to oneself)',
        file: 'src/modules/emails/emails.service.ts',
        find: "if (action === 'reply' && email.folder === 'sent')",
        replace: 'if (false)',
        tests: [INTEGRATION('mail')],
    },
    // Configuration and transport
    {
        name: 'production accepts short secrets',
        file: 'src/config/env.ts',
        find: 'if (secret.length < 32 || secret.startsWith(',
        replace: 'if (secret.length < 3 || secret.startsWith(',
        tests: [UNIT('env')],
    },
    {
        name: 'production runs without trusting its TLS proxy',
        file: 'src/config/env.ts',
        find: 'if (value.TRUST_PROXY < 1)',
        replace: 'if (false)',
        tests: [UNIT('env')],
    },
    {
        name: 'production SMTP may stay unencrypted',
        file: 'src/integrations/mailer.ts',
        find: "requireTLS: !smtp.secure && nodeEnv === 'production',",
        replace: 'requireTLS: false,',
        tests: [UNIT('auth')],
    },
];
