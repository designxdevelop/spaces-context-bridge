# Changelog

## 0.1.5 — unreleased, private release preparation

Prepared documentation for the single-owner MCP relay, scoped ChatGPT worker prompt, client setup, data handling, verification, and proposed deployment workflow. Added a design-only opt-in transcript companion and conditional launch draft. MIT licensing remains pending owner approval.

The inherited implementation includes asynchronous lookup/edit/transcript requests, OAuth agent/worker roles, event subscriptions, delivery retries, leases, and request idempotency. Local model tests are separate from real Cloudflare and client acceptance tests. Event-worker activation and complete bridge-mediated operations remain unverified; direct Pages tests are not bridge acceptance evidence.

No public release date, deployment success, security certification, native Meetings import, or automatic transcript sync is claimed.

Release-review hardening: refuse consent when role hashes are equal; treat webhook 410/413 as terminal until callback reconfiguration; cap transcript/result fields at 40,000 UTF-16 units to fit the 256 KiB JSON body cap. OAuth refresh replay revokes all grants/subscriptions for that client; hosts must serialize refresh. These changes remain version 0.1.5 pending owner release review.
