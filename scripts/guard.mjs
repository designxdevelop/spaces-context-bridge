// Refuses remote Cloudflare operations unless the target account is explicit and not protected.
// Workers Builds (WORKERS_CI) is already bound to the owner's account, so an explicit account is not required there;
// the protected/allowed lists still apply whenever CLOUDFLARE_ACCOUNT_ID is set. Generic CI gets no exemption.
import { readFileSync } from 'node:fs';

const config = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
const problems = [];
if (/"(account_id|routes?|zone_id)"\s*:/.test(config.replace(/\/\/.*$/gm, ''))) problems.push('wrangler.jsonc must not pin account_id, routes or zone_id.');

const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const csv = name => (process.env[name] || '').split(',').map(s => s.trim()).filter(Boolean);
const allowed = csv('BRIDGE_ALLOWED_ACCOUNT_IDS'), protectedIds = csv('BRIDGE_PROTECTED_ACCOUNT_IDS');
if (!account) {
  if (!process.env.WORKERS_CI) problems.push('Set CLOUDFLARE_ACCOUNT_ID to the account you intend to deploy to (Dashboard > Workers & Pages > Account ID). Remote commands never guess the account.');
} else {
  if (protectedIds.includes(account)) problems.push('CLOUDFLARE_ACCOUNT_ID is listed in BRIDGE_PROTECTED_ACCOUNT_IDS.');
  if (allowed.length && !allowed.includes(account)) problems.push('CLOUDFLARE_ACCOUNT_ID is not in BRIDGE_ALLOWED_ACCOUNT_IDS.');
}
if (problems.length) {
  console.error('Remote operation blocked:\n- ' + problems.join('\n- '));
  process.exit(1);
}
