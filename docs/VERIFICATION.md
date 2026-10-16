# Verification gates

See [release review](RELEASE_REVIEW.md) for the current evidence. Hosted OAuth/protocol checks and a clean CLI deployment have been exercised; ChatGPT event activation and actual Page round trips remain separate gates. Historical authentication success is not a release acceptance result. Use fresh resources, a disposable Space/Page, and synthetic text. Keep evidence to request IDs, redacted statuses, timings, versions, and checksums; never publish tokens, callback secrets, transcripts, or private Page links.

## Local evidence

Run `npm ci` and `npm run verify` using Node 22.13 or later; `node --test bridge.test.mjs` is the focused baseline. The Node suites emulate D1 with SQLite. The smoke script separately runs real local workerd/local D1 with a seeded subscription; it does not verify ChatGPT callback reachability or processing. Hosted checks establish remote OAuth/D1 behavior, not actual client consent or document effects. Record their output separately from hosted acceptance evidence.

## Hosted acceptance

1. **Clean installation and consent:** deploy into a new account-selected Worker/database, authenticate separate clients as agent and worker, and verify their roles. An unauthenticated request must fail; an agent must not claim work.
2. **Activation:** observe `request.created` discovery, subscription, successful signed verification, stored expiration, and actual delivery. Check `worker_connected`, then observe the Work chat waking. Keep webhook secrets out of logs.
3. **Lookup and edit:** request a unique synthetic fact through the agent, poll its original request ID, and verify the cited source independently. Request one authorized disposable edit and independently reread the Page. An out-of-scope edit must be refused without modifying it.
4. **Transcript and duplicate recovery:** send synthetic text with stable `source_id` and `idempotency_key`; verify one Page in the allowed Space and a source marker. Retry identical input, then test a lost-response/reclaimed-lease scenario; confirm no duplicate write before claiming recovery works.
5. **Lifecycle:** test subscription refresh, disconnection/revocation, delivery failure, lease expiry, and cleanup in isolated fixtures. Stop monitoring and verify unsubscribe stops delivery. Confirm another agent client cannot read the first client's result.

A direct Pages edit skips the relay and proves only that Pages tools work. A webhook `2xx` proves receipt, not Page mutation. A `completed` result needs an independently checked source or edit receipt. On timeout, use `get_result` with the existing ID; do not submit another operation with a fresh key.

## Release evidence still required

The final review must contain fresh deployment evidence, actual worker activation, all three bridge-mediated operations, independent Page verification, owner-scope refusal, recovery behavior, and approved license/contact details. No release announcement should describe this path as working before those gates are cleared.
