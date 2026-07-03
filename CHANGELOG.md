# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The plugin (`@version` in `DiscordMcpBridge.plugin.js`) and the Python package
(`version` in `pyproject.toml`) share the same version number.

## [Unreleased]

## [0.6.0] - 2026-07-03

### Added
- `get_roles` — list a guild's roles (id, name, color, position, permissions),
  handy for decoding the role IDs returned by `list_members`.
- `get_guild_info` — guild metadata: name, description, creation date, member
  count, roles, channels/categories, features, boost (premium) tier, owner.
- `resolve_id` — classify any snowflake as guild/channel/thread/user/message
  and return brief info plus its creation time.
- `get_reactions` — list the users who reacted to a message with a given emoji
  (unicode char or custom-emoji snowflake).
- `list_threads_paginated` — offset/limit pagination over forum posts/threads,
  returning `{threads, hasMore, total}` (`hasMore`/`total` are heuristics).
  `list_threads` is unchanged and still returns a flat list.
- `download_attachment` — download a single Discord CDN attachment
  (cdn.discordapp.com / media.discordapp.net only) into `exports/`.
- `export_attachments` — walk a channel's history, download all attachments
  concurrently, and write an `attachments_<channel_id>.json` manifest.
- `search_local` — offline full-text search (SQLite FTS5) over `exports/*.json`
  produced by `export_channel`; the index rebuilds incrementally by file mtime.
  New module `discord_mcp/local_index.py`.
- `channel_stats` — offline analytics from a channel export: per-user counts,
  top authors, reply/mention graph, active hours/days, time distribution, and a
  summary. New module `discord_mcp/analytics.py`.

### Changed
- `list_members` gained `resolve_role_names` (default False); when True each
  member also carries `role_names`. Existing fields (`id`, `username`, `nick`,
  `roles`) are unchanged.
- `get_messages` gained a `humanize` flag (default False); when True each
  message also carries `content_human` with mentions (`<#chan>`, `<@user>`,
  `<@&role>`, `<:emoji:id>`) resolved. The original `content` is untouched.

### Dependencies
- Added `httpx>=0.24.0` (used by the attachment-download tools).

## [0.5.1] - 2026-07-03

### Fixed
- System messages (member joins, server boosts, pins, thread-created, etc.)
  are no longer reported as empty. Discord stores these with an empty
  `content` and renders their text on the client from the message `type`, so
  a channel full of joins/boosts previously looked empty. Each formatted
  message now carries its numeric `type` plus a human-readable `system_text`.
  For `USER_JOIN` (type 7) the plugin reproduces Discord's deterministic
  template selection from the message snowflake (English wording; the client
  may show a localized variant).

## [0.5.0] - 2026-07-03

### Added
- `read_thread` — read a thread or forum post's messages in chronological
  order (oldest first), a convenience wrapper over the message fetch.
- `get_pins` — list a channel's or thread's pinned messages. The plugin
  resolves `ChannelPinsStore` and the `fetchPins` action creator, lazily loads
  pins via a REST call, and reads them by subscribing to the
  `LOAD_PINNED_MESSAGES_SUCCESS` dispatch.
- `get_channel_info` — metadata for a channel or thread (name, type, guild,
  parent, topic, and thread fields: owner, message/member counts, archived).

### Changed
- `list_threads` now loads forum/archived posts that aren't cached. It calls
  the `loadArchivedThreads` action creator and captures the
  `LOAD_ARCHIVED_THREADS_SUCCESS` dispatch payload directly (the REST promise
  never settles from the plugin context), so forum channels return their posts.
  Each thread now also includes `message_count` and, when available,
  `first_message` (the post's opening message: author, content, attachments).
- `ping` and `diagnostics` now also report the threads/pins modules
  (`threadsStore`, `loadArchivedThreads`, `pinsStore`, `fetchPins`).

## [0.4.0] - 2026-07-03

### Fixed
- `search_messages` now works. Reworked it to use Discord's native Flux search
  path instead of a direct REST call: the plugin resolves the search action
  creator, the FluxDispatcher, and the `SearchType` enum, calls
  `fetchMessages({searchContext, searchQueryString, pagination})`, and reads
  results by subscribing to the `SEARCH_MESSAGES_SUCCESS` dispatch (the
  underlying REST promise never settles from the plugin context). Handles
  `SEARCH_MESSAGES_INDEXING` (retries while the guild index builds) and
  `SEARCH_MESSAGES_FAILURE`.

### Changed
- `ping` and `diagnostics` now report the search sub-modules
  (`searchActionCreator`, `dispatcher`, `searchType`) instead of the removed
  HTTP client fields.

### Removed
- The HTTP-client search fallback. On the tested Discord build the resolved
  REST client's promises never settle from the plugin context, so it was a
  dead end; the Flux path replaces it.

## [0.3.0] - 2026-07-03

### Added
- New tools / plugin methods: `ping` (lightweight health check with plugin
  version and resolved-module map), `get_message_by_link`, `list_dms`,
  `list_threads`, `get_user_info`.
- `get_messages` gained `author_id` and `after` filters.
- Richer message payloads: `embeds`, `reactions`, `edited_timestamp`,
  `pinned`, and a summarized `referenced_message` for replies.
- Settings panel in the plugin to configure the bridge port from the Discord
  UI (persisted via `BdApi.Data`).
- Dev tooling: pytest smoke tests for the bridge, `ruff` lint config, and a
  GitHub Actions CI workflow (Python tests + JS syntax check).

### Changed
- Reconnect now uses capped exponential backoff (3s → 30s) that resets on a
  successful connection.

## [0.2.0] - 2026-07-03

### Added
- `diagnostics` tool / `diag` plugin method to inspect which internal Discord
  modules resolved — useful when Discord updates break selectors.

### Changed
- Plugin metadata, comments, toasts, and error messages translated to English.
- Resolve stores by name via `Webpack.getStore` with a property-search
  fallback, making module resolution more robust across Discord updates.
- `getChannels` tries multiple store method names across Discord versions.

### Fixed
- `fetchMessages` is now called as a module method so its internal `this`
  binding is preserved (previously threw `this.fetchLocalMessages is not a
  function`).

## [0.1.0] - 2026-07-03

### Added
- Initial release: Python MCP server + BetterDiscord bridge plugin.
- WebSocket bridge (`127.0.0.1:8787`) between the MCP server and the plugin.
- Tools: `bridge_status`, `list_guilds`, `list_channels`, `get_messages`,
  `search_messages`, `list_members`, `export_channel`.
