# Contributing

This is private release preparation at version 0.1.5. Keep work local unless the release owner explicitly authorizes publication. MIT remains proposed, not approved.

1. Read the README, security policy and verification gates. Use synthetic data and fresh resources; never reuse another owner's deployment or credentials.
2. Make a focused change. Preserve other contributors' edits and document any schema, authorization, or behavior changes.
3. Run `npm ci` and `npm run verify` using Node 22.13 or later. The focused baseline is `node --test bridge.test.mjs`. Test changed security or recovery invariants; distinguish local models from actual hosted evidence.
4. Review the diff for tokens, personal origins, account/database/Page IDs, recordings, exports and absolute home paths. Include sanitized reproduction steps and meaningful check results.
5. Submit for review only through the workflow authorized by the maintainer. Do not publish packages, deploy, change live Pages, or enable recurring tasks as an incidental test.

For client or protocol changes, cite current primary documentation and record the tested versions. Never mark a request completed merely because it was queued or a direct tool call succeeded. See [security reporting](SECURITY.md) for vulnerabilities.
