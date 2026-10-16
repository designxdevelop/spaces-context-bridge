# Launch post (draft)

**Unpublished draft.** A real recording import has not been verified end to end.

## Post

I wanted a Granola-style meeting workflow built from tools I already use. Superwhisper records on my Mac, ChatGPT Spaces holds the notes, and my coding agent can read them or file new ones.

So I built Spaces Context Bridge, a small open-source MCP server that runs on your Mac. Ask your agent to "save my latest meeting notes in Personal Notes". It reads the recording through Superwhisper's MCP, and the bridge saves it as a Page in that Space through your signed-in Codex CLI. Reads and careful edits work the same way. In my testing, reads and writes finished in about 2 to 11 seconds.

You run it yourself under MIT. It's not a hosted service, and nothing syncs in the background; it saves what you ask for.

github.com/designxdevelop/spaces-context-bridge

## Before posting

- Clean source installation passed with fresh local config/key and existing owner sign-in. Do not imply a fresh-account test or promise a setup time.
- Use Superwhisper's current feature name, Meetings, not "Notes". Confirm against the [Superwhisper changelog](https://superwhisper.com/changelog) and its [CLI/MCP announcement](https://superwhisper.com/blog/cli-mcp). Keep dates out of the post.
- The Granola comparison is framing only. Don't claim feature parity, lower cost, better accuracy or local-only processing.
- Don't claim automatic ingestion, a fresh-user end-to-end test, or live testing of clients other than the Executor route.
- Keep out personal names, Space or Page names other than the example, links, recordings, endpoints and screenshots containing private content.
