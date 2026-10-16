# Cloudflare deployment option

This is the currently implemented backend, selected only when you choose Cloudflare. For agent-assisted connection to an existing endpoint or another backend plan, use [setup with your agent](SETUP_WITH_AGENT.md). Another runtime needs an adapter; client MCP configuration alone does not host this server.

The CLI provisions a D1 database, applies migrations, and deploys the Worker into your own Cloudflare account. The official button uses the public source repository. The full browser-button and fresh-human signup flow still needs verification; the clean CLI installation is separate evidence. See [release evidence](RELEASE_REVIEW.md).

## CLI quickstart

Use Node 22.13 or newer (Node 22/24 are CI targets), npm, and your own Cloudflare account. Complete signup and Workers subdomain setup yourself. ChatGPT Work Cloud and source tools are separate prerequisites.

1. Clone the source and run `npm ci`. Run `npx wrangler login` and complete browser sign-in yourself. Check `npx wrangler whoami` privately and choose the intended account; do not paste its output into issues.
2. In `wrangler.jsonc`, choose a new unique Worker `name` and D1 `database_name`. Keep binding `DB`, migrations directory, compatibility settings and cron. Do not copy another installation's database ID. An existing database with the same name is reused for upgrades; choose a different name for an isolated installation.
3. Run `npm run setup`. This writes separate random agent/worker codes to `.bridge-secrets/connection-codes.txt` (0600) and their hashes to `.dev.vars` (0600). Neither file belongs in Git. Retain the codes securely; never put them in prompts, shell arguments or bug reports.
4. Run `CLOUDFLARE_ACCOUNT_ID=<your-account-id> npm run deploy`, substituting your account ID from the dashboard. Confirm the interactive migration prompt. The script explicitly creates the named D1 database if missing, migrates it, then deploys with the protected local secret file. It stops on failure. Migration alone does not provision D1.
5. Visit the returned `/health` endpoint. Confirm database and both code hashes are configured, then follow [client setup](CLIENTS.md) and [verification](VERIFICATION.md). Sign-in is not an event processor.

`PUBLIC_ORIGIN` is optional: the Worker derives its issuer/resource origin from the incoming HTTPS URL. For a custom domain, configure it in Cloudflare, then run `npm run setup -- --origin https://your-domain.example` and deploy again. The pin must be a bare HTTPS origin without path, query, fragment or credentials. Other origins are rejected. Setup/upload reruns preserve a configured pin.

The account guard supports optional comma-separated `BRIDGE_ALLOWED_ACCOUNT_IDS` and `BRIDGE_PROTECTED_ACCOUNT_IDS`. Generic CI needs an explicit account. Workers Builds supplies account context through `WORKERS_CI`; that flag is a convenience, not a security boundary.

## Official Deploy button

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/designxdevelop/spaces-context-bridge)

Cloudflare's [official requirements](https://developers.cloudflare.com/workers/platform/deploy-buttons/) cover a public repository, Wrangler configuration, package scripts, resource provisioning, and required secrets detected from `.dev.vars.example`. Package metadata supplies binding/secret descriptions. Cloudflare should select `npm run deploy`; its Workers Builds path migrates before deployment and relies on Cloudflare provisioning `DB` before that command. **The real button flow remains a release blocker until tested.** A CLI deployment does not establish button behavior.

Generate codes locally with `npm run setup`. If the form asks for secret values, use `npm run setup -- --print-hashes` privately and copy only the corresponding hashes; retain the original codes for consent. If hashes are absent after creation, configure them in the new Worker's dashboard before connecting clients. Consent fails closed with 503 when the selected role's hash is missing.

The button deploys infrastructure. It does not approve OAuth, install the ChatGPT worker, grant Pages access, or sync recordings.

## Settings

| Setting | Purpose |
| --- | --- |
| `DB` | Owner's D1 database for auth, queue, outbox, subscriptions and results |
| `AGENT_LOGIN_HASH` | Unpadded base64url SHA-256 of the agent connection code |
| `WORKER_LOGIN_HASH` | Same digest format for a separate worker connection code |
| `PUBLIC_ORIGIN` | Optional exact HTTPS issuer/resource origin pin |
| Cron | Five-minute retries, stalled-request recovery and retention cleanup |

No provider API key is stored by this relay. Page/Space scope belongs in the [worker prompt](../prompts/CHATGPT_WORKER_PROMPT.txt) and source permissions; it is not a server-side allowlist. See [operations](OPERATIONS.md) for backup and upgrades. The archived legacy migration is only for an untouched 0.1.0 schema, not a fresh bootstrap or an instruction to alter a personal deployment.

## Upgrade an existing installation from shared source

Keep personal deployment settings and backups outside the repository. Reuse the existing database UUID, Worker name, origin/routes and secrets; the checked-in configuration is a fresh-install template. Review and pin the approved upstream revision, test it in isolation, back up the intended database, and apply numbered migrations before deploying. Record the source revision with the Worker version so a runtime version string cannot be mistaken for proof of current source.

Avoid running setup or uploading another installation's `.dev.vars` during an upgrade: that can replace the existing connection-code hashes. With an external Wrangler configuration pointing at the shared source, deploy through the pinned Wrangler CLI with `--keep-vars` and no `--secrets-file`. Preserve the cron and privacy settings. See [operations](OPERATIONS.md) for backup, migration and rollback limits. Upgrades are deliberate deployments; pulling Git does not update a live Worker automatically.
