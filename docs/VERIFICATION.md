# Verification

How to check an install before trusting it with real notes. Use a disposable Space and Page and synthetic text. Keep evidence to statuses, timings, versions and hashes. Never record keys, Page links, recording content or transcripts.

## Direct adapter

### Automated checks

```sh
npm run verify
```

`npm run verify` runs the synthetic Node tests and release audit. `npm test` runs the full suite; `npm run test:direct` runs the adapter tests without the release-audit tests. No dependency installation is required. These checks don't contact ChatGPT, Codex or Superwhisper.

### Live acceptance

Run these on your own Mac with the server started by `npm start`.

1. **Status.** With the read-only config, `bridge_direct_status` with `check_upstream: true` reports no writable Spaces, the limits, and reachable upstream tools.
2. **Auth.** A request without the key, or with a wrong key, gets `401` before anything upstream starts. A request with a foreign `Origin` header gets `403`.
3. **Read.** `list_spaces`, then `list_pages` and `read_page` on a disposable Page.
4. **Write refused.** A save to a Space that isn't on the allowlist is refused, and no Page appears.
5. **Allow the test Space.** Rerun setup with `--allow-space` for the disposable Space and restart.
6. **Edit.** `patch_page` changes one sentence. An independent read shows only that change.
7. **Transcript save.** Save synthetic timestamped segments with `save_transcript`. An independent read shows the exact text, label and source ID, with timings and speaker labels intact. Repeating the identical call returns the same Page.
8. **Notes save.** Save synthetic notes with `save_meeting_notes`. They land in their own labeled block, separate from any transcript.
9. **Limits.** Text containing a line that would close the code fence is rejected before writing, and so is text over 200,000 UTF-8 bytes.
10. **Sources (optional).** Read a Superwhisper recording you pick through its MCP server, and, only if requested, list ChatGPT Meetings notes for a date range. Don't copy the content into your evidence.

### What doesn't count

- A successful `bridge_direct_status` call shows routing and authentication, not that writes work.
- A Spaces call made through some other tool bypasses the adapter and proves nothing about it.
- A creation receipt without an independent readback is `saved_verification_pending`, not verified.

### Client coverage

The live verified route is T3 Code with the Codex provider → personal Executor → local adapter. Codex, Claude Code and OpenCode configuration examples are documented but have not been verified live. ChatGPT app connectors cannot reach loopback and are unsupported. Automated tests do not close these client verification gaps.
