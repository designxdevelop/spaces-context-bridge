# Private release review — 0.1.5

Prepared October 16, 2026. **The original cloud event workflow has passed all three synthetic bridge round trips. This remains a private release candidate.** The original synthetic review left the personal deployment, documents and client connections unchanged. The maintainer later authorized the shared-source personal upgrade recorded below. Test origins, credentials, Page IDs and request receipts remain in protected local evidence outside this repository.

## Verified behavior

| Area | Evidence |
| --- | --- |
| Local verification | 112 tests passed, one optional installed-CLI check skipped, zero failures; Worker dry run and all 11 real local workerd/D1 smoke checks passed. The original 14 handoff tests remain included. |
| Fresh CLI deployment | A clean source copy with `npm ci`, generated codes, a new Worker and new D1 completed creation, migration and deployment. This used an existing authenticated Cloudflare account, not a fresh human signup. Final source was also deployed to the separate bootstrap resources. |
| Hosted OAuth/protocol | Six checks passed against isolated remote D1: discovery, concurrent role sign-ins, CSRF/PKCE/single-use codes, both protocol modes, role denial, disconnected-worker refusal, foreign-Origin rejection, refresh rotation/replay and revocation. Final bootstrap checks include three refresh/replay cycles. |
| Executor in T3/Codex | Actual discovery exposed all five agent tools; saved per-user agent OAuth returned the correct role. Requests and original-ID result retrieval used the actual Executor connection. This does not validate every T3 provider or client. |
| ChatGPT cloud activation | A native event-triggered task was saved and enabled with empty `request.created` filters, exact synthetic owner scope and no timer. Signed callback verification succeeded. Actual Executor status returned `worker_connected: true`; events automatically woke ChatGPT and it claimed requests. No local daemon or copied-note store was used. |
| Lookup | The agent request completed in about 48 seconds with the correct fictional date and source citation. The source Page was independently read. |
| Edit | The agent request completed in about 102 seconds. Independent before/after reads found exactly one authorized status-sentence change; the title and all other blocks stayed unchanged. |
| Transcript | The agent request completed in about 70 seconds. Independent reading verified the complete synthetic transcript verbatim, `source_id`, timestamp and correct Space/root parent. Exactly one new child Page appeared. This creates a Page, not a native Meetings recording. |
| Retry and reconciliation | Same-key transcript retry returned the original completed request ID. A new-key request for the same source automatically ran on the final source revision and refused to recreate the output after its owner moved it to Trash; independent read confirmed `page_trashed`, and the owner confirmed the action. No duplicate was created. Reusing an accessible existing Page and interrupted-write recovery remain unverified. |
| End-of-test cleanup | The owned temporary QA task was paused; actual Executor status returned `worker_connected: false`, confirming unsubscribe. Personal connections and deployment stayed unchanged. |
| OpenCode config | OpenCode 2.0.22 parsed the V2 example in an isolated profile; all four config checks passed when the optional CLI check was enabled. No live OpenCode OAuth/model call or personal config migration was performed. |

The first full live trio used `worker.mjs` SHA-256 `06be7501a97acf7cfdba8286a2f58e4df0c61c774c43c2e0902a09c876cf379f`. Final response cleanup and regression coverage use `66d1df9243639b37f26d122c1288931f9de971a40652de2a9487878e445eee9a`. That recorded revision had fresh local and bootstrap-hosted checks; the final revision also automatically claimed and safely failed the trashed-output reconciliation request, without creating another Page. Earlier results do not by themselves validate later revisions.

## Fixes and independent review

Two bridge defects caused the live activation failure: the allowlist omitted the observed exact OpenAI connector callback host, and the pinned workerd runtime rejected `redirect: 'error'` before sending a request. The bridge now permits exact `connectors.api.openai.com` alongside its existing ChatGPT hosts, uses supported manual redirect handling and explicitly rejects every 300–399 response. HTTPS, port 443, no userinfo/fragment, signed challenges and role checks remain enforced. It does not allow arbitrary OpenAI subdomains.

Diagnostics emit fixed method, error and value-shape categories only. They never serialize URLs, parameters, exception messages, credentials or transcript text. A temporary hostname-only diagnostic was encrypted into protected local storage, then removed with its key and plaintext. No capture code is shipped.

Claude Opus 5.5 owned authentication/security and refresh-replay hardening; Claude Sonnet 5.5 owned deployment/CI and bootstrap fixes. GPT-6 Astra owned onboarding/docs and an independent review; GPT-6.1 Sol owned T3/OpenCode/Executor examples. The orchestrator integrated their work and retained the required generated `.cursor` rule. Earlier findings corrected lease recovery, origin preservation, index auditing, edit annotations, equal-role hashes, terminal webhook recovery and field limits.

Opus and Sonnet independently reviewed the callback fixes without blocking findings. Their low-severity URL normalization, unused-body cleanup and redirect-test gaps were addressed. Fetch targets are normalized while stored subscription identity remains unchanged for upgrade/unsubscribe compatibility. Unused callback bodies are cancelled, including oversized verification responses; regression tests cover actual 302 verification/delivery behavior and private-value sentinels.

## PR #1 independent review fixes

Astra 6 medium identified the concurrent hourly-limit race and encoded checkout-path failure. Opus 5.5 high identified registration cleanup breaking cached-ID reconnects, anonymous registration capacity exhaustion, and gone callbacks still counting as connected. All five findings were accepted and fixed. Registration activity uses additive migration `0002`, preserving the original client schema and giving existing registrations a one-time grace period. New regressions cover the concurrency, lifecycle, migration and callback cases. Astra’s follow-up found a 410/re-verification race; the subscription expiry and terminal delivery transition now commit in one D1 batch, with a regression proving subsequent recovery.

The updated candidate passed 112 local tests (one optional installed-CLI check skipped), the Worker build, and all 11 local workerd/D1 checks from a checkout containing spaces, percent, hash and Unicode characters. The last Opus follow-up also corrected pre-upgrade restore quarantine and renewals that started before a 410; documented owner-reviewed legacy-cap cleanup and the 24-hour recovery bound; and added restore/renewal/cleanup regressions. These post-review changes have local evidence only: the earlier hosted Page round trips and deployment checks above apply to their recorded revisions. They were not redeployed to the personal or review service during this PR review.

## Latest-main installation and maintainer upgrade

The reviewed `main` revision `2fd329c` was installed from a clean tracked-source checkout with `npm ci`, new synthetic credentials, a new Worker and new D1 database. Both numbered migrations and deployment completed using the documented CLI flow. All six hosted OAuth/protocol checks passed. This used an existing authenticated Cloudflare account; fresh-human signup and the public button remain unverified. The latest revision was also deployed to the isolated bootstrap instance, preserving its existing secrets. A test attempt there used a mismatched credential fixture and was not counted as passing evidence; fresh-install acceptance used that installation's own generated credentials.

After explicit owner authorization, the maintainer's personal backend was upgraded to this same source with an external private deployment overlay. A protected backup was restored locally and both numbered migrations preserved every existing application-table row. The live upgrade kept the existing endpoint, database, secrets, origin and cron; the existing worker-role connection and public discovery checks passed afterwards. This is an upgrade of the shared backend, not a private code fork. Private settings and backups are outside the repository.

The personal backend has no active ChatGPT `request.created` subscription; that was true before and after the upgrade. Personal background processing and an Executor cutover are therefore not claimed by the deployment evidence. The earlier three-operation synthetic workflow evidence remains the isolated review route above. The shared Worker source SHA-256 is `fa6076a335c16a72c5816e5134f14a1968b52a5323c521b90f1fe4e287ebc82a`; runtime version remains 0.1.5.

MIT licensing with copyright attributed to Design X Develop was approved by the owner and is now adopted in the license and package metadata. This does not approve public visibility or launch publication.

## Remaining release gates

1. **Extended acceptance:** the negative date-edit probe was rejected by automatic approval before queue submission because it exceeded the exact sentence authorization. It needs explicit owner approval. Live lost-response/lease-recovery reconciliation remains unverified; local contract tests cover the mechanics. A same-key retry is not proof of interrupted external-write recovery.
2. **Deployment experience:** the official button needs public source, so its fresh-account binding/secrets/migration flow remains untested while this repo is private. The fresh CLI test is separate evidence. Another backend still needs an adapter.
3. **Client and personal cutover:** live OpenCode, other T3 providers and Claude app/Code release workflows remain unverified. The demonstrated T3/Codex Executor review route has not yet been repeated with the personal endpoint; existing personal connections remain in place. Official Superwhisper recording extraction/selection remains untested; all transcripts used here were synthetic.
4. **Historical transient:** an earlier hosted refresh-revocation assertion failed immediately after deployment, then passed after the same-source redeploy. Ten more cycles passed without redeployment and subsequent bootstrap runs passed. D1 read replication was disabled. Its cause remains unknown; repeat passes do not establish the cause.
5. **Publication decisions:** finalize the private vulnerability-reporting channel, review repository/history hygiene and approve public visibility and launch copy. MIT / Design X Develop is approved. No public publication has occurred; the authorized personal backend upgrade above is complete.

## Review artifacts

Start with [README](../README.md), [deployment](DEPLOYMENT.md), [client setup](CLIENTS.md), [T3/OpenCode/Executor](CLIENTS_T3_OPENCODE_EXECUTOR.md), [verification gates](VERIFICATION.md), [operations/privacy](OPERATIONS.md) and the [unpublished launch draft](LAUNCH_POST.md). Backup exports and private connection files must never be attached to public issues.

The [setup prompt](SETUP_WITH_AGENT.md) supports the owner's choice of requester/router/backend; Cloudflare is the only shipped backend adapter. The [scheduled processor proposal](SCHEDULED_PROCESSOR_PROPOSAL.md) was not implemented or enabled after automatic approval rejected its new queue/state mode. It is unnecessary for the now-verified native event route.
