# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The plugin (`@version` in `DiscordMcpBridge.plugin.js`) and the Python package
(`version` in `pyproject.toml`) share the same version number.

## [Unreleased]

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
