# Contributing

Spaces Context Bridge is MIT-licensed software run by each owner on their own machine. Keep personal configuration, credentials and notes out of contributions.

1. Read the README and security policy. Use synthetic content, fake upstreams and isolated temporary configuration for tests.
2. Make a focused change. Preserve other contributors' edits and document changes to authorization, tool boundaries or recovery behavior.
3. Run `npm run verify` with Node.js 22.13 or newer. There are no npm dependencies. Tests use Node's test runner and never need personal credentials, recordings or live Page writes.
4. Review the diff for keys, personal paths, private endpoints, Page IDs and recording content. Include sanitized reproduction steps and relevant check results.
5. Submit through the maintainer-authorized review workflow. Do not change live Pages, client connections or background services as an incidental test.

For client or protocol changes, cite current primary documentation and record tested versions. Distinguish synthetic contracts from live MCP calls and independent Page readback. A connection entry or creation receipt alone does not verify an operation. See [verification](docs/VERIFICATION.md) and [security reporting](SECURITY.md).
