# Security policy

Version 0.1.5 is a self-hosted, single-owner relay. Security fixes target the current release. Each operator controls their own deployment, database and client permissions.

## Report privately

Use [GitHub private vulnerability reporting](https://github.com/designxdevelop/spaces-context-bridge/security/advisories/new), also available under **Security → Report a vulnerability**. Do not place credentials, transcript text, private source links or exploit details in a public issue. No response-time SLA is promised.

For ordinary setup questions, bugs and feature requests, use [GitHub Issues](https://github.com/designxdevelop/spaces-context-bridge/issues/new/choose).

Provide the affected version, a synthetic reproduction, impact, and redacted evidence. Do not test against deployments you do not own. No public bug bounty or blanket authorization to access third-party resources is offered.

## Trust boundaries

Agent-role access can submit lookups, edit requests and transcripts. Worker-role access can read/claim queued payloads across this owner's clients and report results. All clients must belong to the same trusted owner. OAuth role checks are not fine-grained Page authorization. Page allowlists in the worker prompt are model instructions, not server-enforced access control; source permissions remain essential.

Requests, Pages and transcripts are untrusted content. They cannot widen the owner's approved scope or authorize sending secrets. Use exact write destinations, reread before changes, and independently verify receipts. The deployment contains sensitive plaintext payloads and webhook signing secrets in D1; protect database access and backups.

## Incident handling

Pause producers and worker processing, revoke affected clients/tokens/subscriptions, rotate connection codes, and inspect authorized destinations for unintended edits. Rotating login hashes alone does not invalidate existing sessions. Restoring a database may restore credentials or old work; sanitize authorization and reconcile writes before reactivation. Follow [operations](docs/OPERATIONS.md).
