/**
 * @name DiscordMcpBridge
 * @author you
 * @description Bridge between the Discord client and a Python MCP server.
 *   Reads data from the authenticated client and exposes it to an AI agent.
 *   Self-bot tool — violates Discord ToS. Use at your own risk.
 * @version 0.2.0
 * @source https://github.com/<your-username>/betterdiscord-mcp
 */

const BRIDGE_PORT = 8787; // must match BRIDGE_PORT in .env
const BRIDGE_URL = `ws://127.0.0.1:${BRIDGE_PORT}`;

module.exports = class DiscordMcpBridge {
  constructor() {
    this.ws = null;
    this.reconnectTimer = null;
    this.stores = {};
    this.actions = {};
  }

  start() {
    this._resolveModules();
    this._connect();
    BdApi.UI.showToast("DiscordMcpBridge started", { type: "info" });
  }

  stop() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
  }

  // --- Resolve Discord's internal modules via Webpack ---
  _resolveModules() {
    const { Webpack } = BdApi;
    const byProps = (...p) => Webpack.getModule((m) => p.every((k) => m?.[k]));
    // Prefer resolving stores by name; fall back to property search.
    const store = (name, ...props) =>
      Webpack.getStore?.(name) || byProps(...props);

    this.stores.guild = store("GuildStore", "getGuild", "getGuilds");
    this.stores.channel = store(
      "ChannelStore",
      "getChannel",
      "getMutableGuildChannels"
    );
    this.stores.message = store("MessageStore", "getMessages", "getMessage");
    this.stores.user = store("UserStore", "getUser", "getCurrentUser");
    this.stores.member = store("GuildMemberStore", "getMember", "getMembers");

    // Channel history fetch action: try several module signatures.
    this.actions.fetchMessages =
      byProps("fetchMessages", "receiveMessage") ||
      byProps("fetchMessages", "jumpToMessage") ||
      byProps("fetchMessages");
    // Server-wide search.
    this.actions.search =
      byProps("searchMessages", "queryMessages") || byProps("searchMessages");
  }

  // --- WebSocket connection with auto-reconnect ---
  _connect() {
    try {
      this.ws = new WebSocket(BRIDGE_URL);
    } catch (e) {
      return this._scheduleReconnect();
    }
    this.ws.onopen = () =>
      BdApi.UI.showToast("MCP bridge connected", { type: "success" });
    this.ws.onclose = () => this._scheduleReconnect();
    this.ws.onerror = () => {};
    this.ws.onmessage = (ev) => this._onMessage(ev.data);
  }

  _scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._connect();
    }, 3000);
  }

  async _onMessage(raw) {
    let req;
    try {
      req = JSON.parse(raw);
    } catch {
      return;
    }
    const reply = (patch) =>
      this.ws?.send(JSON.stringify({ id: req.id, ...patch }));
    try {
      const result = await this._dispatch(req.method, req.params || {});
      reply({ ok: true, result });
    } catch (e) {
      reply({ ok: false, error: String(e?.message || e) });
    }
  }

  _dispatch(method, params) {
    const fn = this._handlers()[method];
    if (!fn) throw new Error(`Unknown method: ${method}`);
    return fn(params);
  }

  // --- Formatting helpers ---
  _fmtMessage(m) {
    return {
      id: m.id,
      author: m.author
        ? { id: m.author.id, username: m.author.username }
        : null,
      content: m.content,
      timestamp: m.timestamp?.toString?.() ?? m.timestamp,
      attachments: (m.attachments || []).map((a) => ({
        filename: a.filename,
        url: a.url,
      })),
    };
  }

  _sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  // --- Method handlers called from the Python side ---
  _handlers() {
    return {
      getGuilds: () => {
        const guilds = this.stores.guild.getGuilds();
        return Object.values(guilds).map((g) => ({
          id: g.id,
          name: g.name,
        }));
      },

      diag: () => {
        // Diagnostics: which modules actually resolved.
        const s = this.stores;
        return {
          guildStore: !!s.guild,
          channelStore: !!s.channel,
          channelMethods: s.channel
            ? Object.keys(s.channel).filter((k) => typeof s.channel[k] === "function").slice(0, 40)
            : [],
          messageStore: !!s.message,
          memberStore: !!s.member,
          fetchMessages: !!this.actions.fetchMessages,
          searchMessages: !!this.actions.search,
        };
      },

      getChannels: ({ guildId }) => {
        const st = this.stores.channel;
        // Method name varies across versions — try each in order.
        let all =
          st.getMutableGuildChannels?.() ||
          st.getMutableGuildChannelsForGuild?.(guildId) ||
          st.getAllChannels?.() ||
          {};
        return Object.values(all)
          .filter((c) => c.guild_id === guildId && [0, 5].includes(c.type))
          .map((c) => ({
            id: c.id,
            name: c.name,
            type: c.type,
            topic: c.topic || null,
          }));
      },

      getMembers: ({ guildId }) => {
        const members = this.stores.member.getMembers(guildId) || [];
        return members.map((m) => ({
          id: m.userId,
          nick: m.nick || null,
          roles: m.roles || [],
        }));
      },

      fetchMessages: async ({ channelId, limit, before }) => {
        // Start from whatever is already in the store.
        let cached = this.stores.message.getMessages(channelId);
        let arr = cached?.toArray ? cached.toArray() : [];

        const needFetch = arr.length === 0 || before || arr.length < limit;
        if (needFetch && this.actions.fetchMessages) {
          const mod = this.actions.fetchMessages;
          const opts = {
            channelId,
            limit: Math.min(limit, 100),
            before: before || undefined,
          };
          // Call as a module method so `this` is not lost.
          if (typeof mod.fetchMessages === "function") {
            await mod.fetchMessages(opts);
          } else {
            await mod(opts);
          }
          await this._sleep(800); // let the store update
          cached = this.stores.message.getMessages(channelId);
          arr = cached?.toArray ? cached.toArray() : [];
        }

        let msgs = arr;
        if (before) {
          const idx = msgs.findIndex((m) => m.id === before);
          if (idx >= 0) msgs = msgs.slice(0, idx);
        }
        // Discord keeps messages oldest-first — take the last `limit`
        // and return them newest-first.
        return msgs
          .slice(-limit)
          .reverse()
          .map((m) => this._fmtMessage(m));
      },

      searchMessages: async ({ guildId, query, limit }) => {
        if (!this.actions.search?.searchMessages) {
          throw new Error("Search module not found in this Discord version");
        }
        const res = await this.actions.search.searchMessages({
          searchId: guildId,
          searchType: "guild",
          query: { content: [query] },
        });
        // Response shape: messages is an array of groups [ [msg], ... ].
        const groups = res?.body?.messages || res?.messages || [];
        return groups
          .flat()
          .slice(0, limit)
          .map((m) => ({
            ...this._fmtMessage(m),
            channel_id: m.channel_id,
          }));
      },
    };
  }
};
