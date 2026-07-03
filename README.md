# discord-mcp

An MCP server that lets an AI agent (like Claude) read data from Discord
servers through your own account. It pairs with a BetterDiscord plugin, so
the Python side never handles your token — data is read straight from the
already-authenticated Discord client.

```
Claude ──stdio──> Python MCP ──WebSocket──> BetterDiscord plugin ──> Discord
```

## ⚠️ Disclaimer — read this first

This is a **self-bot** tool. Automating a personal Discord account and
modifying the client (BetterDiscord) **violate the Discord Terms of Service**
and **can get your account banned**.

- Use it **only on your own account and at your own risk**.
- The authors take **no responsibility** for banned accounts or any other
  consequences.
- Reading already-loaded client data is quieter than a raw HTTP self-bot,
  but the risk is **not zero**. Make requests infrequently and in small
  batches.
- Do not use it to collect, redistribute, or publish other people's private
  data. Respect the privacy of the servers you are in.

If you are not comfortable with these terms, use an official Discord bot
via the Developer Portal instead.

## Requirements

- Python 3.10+
- [uv](https://docs.astral.sh/uv/) (package/runtime manager)
- [BetterDiscord](https://betterdiscord.app/) installed
- An MCP-capable client (Claude Desktop or Claude Code)

## Install

**1. Python server (via uv):**

```bash
git clone https://github.com/<your-username>/discord-mcp.git
cd discord-mcp
uv sync
```

**2. BetterDiscord plugin:**

- Copy `plugin/DiscordMcpBridge.plugin.js` into your BD plugins folder:
  - Windows: `%AppData%\BetterDiscord\plugins\`
  - macOS: `~/Library/Application Support/BetterDiscord/plugins/`
  - Linux: `~/.config/BetterDiscord/plugins/`
- In Discord: Settings → Plugins → enable **DiscordMcpBridge**.
- Make sure `BRIDGE_PORT` at the top of the plugin matches your `.env`
  (default `8787`).

**3. Register the MCP server with your client:**

Claude Code (CLI):

```bash
claude mcp add discord -- uv --directory /path/to/discord-mcp run discord-mcp
```

Claude Desktop — add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "discord": {
      "command": "uv",
      "args": ["--directory", "/path/to/discord-mcp", "run", "discord-mcp"]
    }
  }
}
```

Replace `/path/to/discord-mcp` with the absolute path where you cloned the
repo. If `uv` is not on your client's PATH, use the full path to the `uv`
executable in `command`.

## How it works

1. On start, the MCP server opens a WebSocket bridge on `127.0.0.1:8787`.
2. The plugin inside Discord connects to the bridge (you'll see a
   "bridge connected" toast).
3. The agent calls tools; the plugin reads Discord's internal Flux stores
   and returns the data.

No token is ever sent to the Python side — the plugin runs inside your
already-authenticated client.

## Tools

| Tool | Purpose |
|------|---------|
| `bridge_status` | Check whether the plugin is connected |
| `diagnostics` | Show which internal Discord modules resolved (debugging) |
| `list_guilds` | List servers the client can see |
| `list_channels` | List a server's text channels |
| `get_messages` | Read a channel's history (paginate with `before`) |
| `search_messages` | Native Discord search across a server |
| `list_members` | Members currently known to the client |
| `export_channel` | Dump a channel's history to `exports/*.json` |

## Typical flow

Start with `bridge_status`. If connected: `list_guilds` → `list_channels`
→ `get_messages` / `search_messages` / `export_channel`.

## Troubleshooting

- **"Plugin not connected"** — Is Discord running? Is the plugin enabled?
  Do the ports match in `.env` and the plugin?
- **"Module not found" / "is not a function"** — Discord updated and the
  Webpack selectors in `_resolveModules()` drifted. Run `diagnostics` to
  see what resolved, then fix the module filters.
- **Empty history** — Scroll the channel manually once so the client loads
  messages, then retry.

## License

MIT — see [LICENSE](LICENSE). Provided as-is, with no warranty. Using this
software is your responsibility.
