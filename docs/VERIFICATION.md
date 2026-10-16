# Verification

How to check an install before trusting it with real notes. Use a disposable Space and Page and synthetic text. Keep evidence to statuses, timings, versions and hashes. Never record keys, Page links, recording content or transcripts.

## Direct adapter

### Automated checks

```sh
npm ci
npm test
```

`npm test` runs every synthetic test with Node's test runner; `npm run test:direct` runs only the adapter's. They don't contact ChatGPT, Codex or Superwhisper. `npm run verify` adds the cloud relay's Worker build and local smoke checks.

### Live acceptance

Run these on your own Mac with the server started by `npm run direct:start`.

1. **Status.** With the read-only config, `bridge_direct_status` with `check_upstream: true` reports no writable Spaces, the limits, and reachable upstream tools.
2. **Auth.** A request without the key, or with a wrong key, gets `401` before anything upstream starts. A request with a foreign `Origin` header gets `403`.
3. **Read.** `list_spaces`, then `list_pages` and `read_page` on a disposable Page.
4. **Write refused.** A save to a Space that isn't on the allowlist is refused, and no Page appears.
5. **Allow the test Space.** Rerun setup with `--allow-space` for the disposable Space and restart.
6. **Edit.** `patch_page` changes one sentence. An independent read shows only that change.
7. **Transcript save.** Save synthetic timestamped segments with `save_transcript`. An independent read shows the exact text, label and source ID, with timings and speaker labels intact. Repeating the identical call returns the same Page.
8. **Notes save.** Save synthetic notes with `save_meeting_notes`. They land in their own labeled block, separate from any transcript.
9. **Limits.** Text containing a line that would close the code fence is rejected before writing, and so is text over 200,000 UTF-8 bytes.
10. **Sources (optional).** Read a Superwhisper recording you pick through its MCP server, and list ChatGPT Meetings notes for a date range. Don't copy the content into your evidence.

### What doesn't count

- A successful `bridge_direct_status` call shows routing and authentication, not that writes work.
- A Spaces call made through some other tool bypasses the adapter and proves nothing about it.
- A creation receipt without an independent readback is `saved_verification_pending`, not verified.

## Cloud relay (optional)

See the [release review](RELEASE_REVIEW.md) for the cloud relay's historical evidence. Hosted OAuth/protocol checks, a clean CLI deployment, native ChatGPT event activation and all three synthetic Page round trips have passed on isolated resources. Each new deployment/client still needs its own acceptance run. Historical authentication success is not a release acceptance result. Use fresh resources, a disposable Space/Page, and synthetic text. Keep evidence to request IDs, redacted statuses, timings, versions, and checksums; never publish tokens, callback secrets, transcripts, or private Page links.

### Local evidence

Run `npm ci` and `npm run verify` using Node 22.13 or later; `node --test bridge.test.mjs` is the focused baseline. The Node suites emulate D1 with SQLite. The smoke script separately runs real local workerd/local D1 with a seeded subscription; it does not verify ChatGPT callback reachability or processing. Hosted checks establish remote OAuth/D1 behavior, not actual client consent or document effects. Record their output separately from hosted acceptance evidence.

### Hosted acceptance

1. **Clean installation and consent:** deploy into a new account-selected Worker/database, authenticate separate clients as agent and worker, and verify their roles. An unauthenticated request must fail; an agent must not claim work.
2. **Activation:** observe `request.created` discovery, subscription, successful signed verification, stored expiration, and actual delivery. Check `worker_connected`, then observe the Work chat waking. Keep webhook secrets out of logs.
3. **Lookup and edit:** request a unique synthetic fact through the agent, poll its original request ID, and verify the cited source independently. Request one authorized disposable edit and independently reread the Page. An out-of-scope edit must be refused without modifying it.
4. **Transcript and duplicate recovery:** send synthetic text with stable `source_id` and `idempotency_key`; verify one Page in the allowed Space and a source marker. Retry identical input, then test a lost-response/reclaimed-lease scenario; confirm no duplicate write before claiming recovery works.
5. **Lifecycle:** test subscription refresh, disconnection/revocation, delivery failure, lease expiry, and cleanup in isolated fixtures. Stop monitoring and verify unsubscribe stops delivery. Confirm another agent client cannot read the first client's result.

A direct Pages edit skips the relay and proves only that Pages tools work. A webhook `2xx` proves receipt, not Page mutation. A `completed` result needs an independently checked source or edit receipt. On timeout, use `get_result` with the existing ID; do not submit another operation with a fresh key.

### Release evidence still required

The final review must contain fresh deployment evidence, actual worker activation, all three bridge-mediated operations, independent Page verification, owner-scope refusal, recovery behavior, and approved license/contact details. Describe only the demonstrated client, synthetic scope and results; retain the remaining recovery, client and deployment limitations.
