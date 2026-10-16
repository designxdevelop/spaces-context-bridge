# Changelog

## 0.3.0 — October 16, 2026

The current project now ships one local MCP adapter for reading and editing ChatGPT Spaces from other agents. Removed the cloud relay implementation, deployment configuration, dependencies, examples and setup instructions. The historical cloud release remains available at [v0.1.5](https://github.com/designxdevelop/spaces-context-bridge/releases/tag/v0.1.5); this source cleanup does not stop, migrate or delete existing deployments or their data.

Setup and start now have standard `npm run setup` and `npm start` commands; the `direct:setup` and `direct:start` aliases remain compatible. The direct runtime, private configuration format, owner key and save journal are unchanged. Verification runs the adapter tests and release-hygiene scan without npm dependencies. Superwhisper and ChatGPT Meetings remain optional sources.

Consolidated redundant tool-schema, description and mapping tests under behavioral owners, added an HTTP-to-RPC notes-save journey, and tightened repeated documentation. No runtime behavior changed during this audit.

## 0.2.0 — October 16, 2026

The local direct MCP adapter is now included in the public source and is the recommended route for interactive use. It calls the signed-in Codex app-server without starting another model turn or waiting for a ChatGPT event task. Superwhisper remains a separate meeting source; selected meeting notes and raw transcripts can be saved directly into an explicitly chosen Space. ChatGPT Meetings is an additional read source.

Adds owner-only local setup, authenticated loopback HTTP, guarded one-block edits, separate notes/transcript saves, source-based idempotency and exact Page readback. Existing transcript keys and journal entries retain their identity. The optional Cloudflare relay remains available; its runtime and migrations are unchanged at 0.1.5.

README, client setup and reusable prompts now distinguish the recommended local route from the asynchronous cloud route. No automatic recording sync, native Meeting creation, hosted notes service, or remote exposure of the local adapter is introduced. See the release verification notes for the exact tested paths and remaining limits.

## 0.1.5 — October 16, 2026

Prepared documentation for the single-owner MCP relay, scoped ChatGPT worker prompt, client setup, data handling, verification, and proposed deployment workflow. Added a design-only opt-in transcript companion and conditional launch draft. Adopted the MIT license with copyright attributed to Design X Develop.

The inherited implementation includes asynchronous lookup/edit/transcript requests, OAuth agent/worker roles, event subscriptions, delivery retries, leases, and request idempotency. Local model tests are separate from real Cloudflare and client acceptance tests. Native event-worker activation and all three synthetic bridge-mediated operations passed through the T3/Codex Executor review route, with independent source/Page verification. Direct Pages fixture preparation remains separate evidence.

No public release date, deployment success, security certification, native Meetings import, or automatic transcript sync is claimed.

Release-review hardening: refuse consent when role hashes are equal; treat webhook 410/413 as terminal until callback reconfiguration; cap transcript/result fields at 40,000 UTF-16 units to fit the 256 KiB JSON body cap. OAuth refresh replay revokes all grants/subscriptions for that client; hosts must serialize refresh. These changes remain version 0.1.5 pending owner release review.

Live interoperability fixes: allow the exact observed OpenAI connector callback host; replace unsupported workerd redirect-error mode with manual handling plus explicit 3xx rejection; normalize callback fetch targets while preserving stored subscription identity; cancel unused callback bodies. Added fixed-enum diagnostics, private-value regression checks and verification/delivery redirect tests. Equivalent endpoint spellings remain distinct subscription identities for upgrade compatibility.

Independent PR review fixes: enforce the queue budget atomically; resolve setup/deploy/smoke paths with URL decoding; preserve recently authorized registrations through reconnects with an additive activity migration; reclaim unused registrations at capacity; disconnect gone callbacks without overwriting concurrent renewals. Added concurrency, lifecycle, migration and callback regressions.
