# Changelog

## 0.1.5 — unreleased, private release preparation

Prepared documentation for the single-owner MCP relay, scoped ChatGPT worker prompt, client setup, data handling, verification, and proposed deployment workflow. Added a design-only opt-in transcript companion and conditional launch draft. Adopted the MIT license with copyright attributed to Design X Develop.

The inherited implementation includes asynchronous lookup/edit/transcript requests, OAuth agent/worker roles, event subscriptions, delivery retries, leases, and request idempotency. Local model tests are separate from real Cloudflare and client acceptance tests. Native event-worker activation and all three synthetic bridge-mediated operations passed through the T3/Codex Executor review route, with independent source/Page verification. Direct Pages fixture preparation remains separate evidence.

No public release date, deployment success, security certification, native Meetings import, or automatic transcript sync is claimed.

Release-review hardening: refuse consent when role hashes are equal; treat webhook 410/413 as terminal until callback reconfiguration; cap transcript/result fields at 40,000 UTF-16 units to fit the 256 KiB JSON body cap. OAuth refresh replay revokes all grants/subscriptions for that client; hosts must serialize refresh. These changes remain version 0.1.5 pending owner release review.

Live interoperability fixes: allow the exact observed OpenAI connector callback host; replace unsupported workerd redirect-error mode with manual handling plus explicit 3xx rejection; normalize callback fetch targets while preserving stored subscription identity; cancel unused callback bodies. Added fixed-enum diagnostics, private-value regression checks and verification/delivery redirect tests. Equivalent endpoint spellings remain distinct subscription identities for upgrade compatibility.

Independent PR review fixes: enforce the queue budget atomically; resolve setup/deploy/smoke paths with URL decoding; preserve recently authorized registrations through reconnects with an additive activity migration; reclaim unused registrations at capacity; disconnect gone callbacks without overwriting concurrent renewals. Added concurrency, lifecycle, migration and callback regressions.
