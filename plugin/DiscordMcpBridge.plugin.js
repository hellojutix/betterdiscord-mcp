/**
 * @name DiscordMcpBridge
 * @author EncryRose
 * @description Bridge between the Discord client and a Python MCP server.
 *   Reads data from the authenticated client and exposes it to an AI agent.
 *   Self-bot tool — violates Discord ToS. Use at your own risk.
 * @version 0.3.0
 * @source https://github.com/encryrose/betterdiscord-mcp
 */

const DEFAULT_BRIDGE_PORT = 8787; // must match BRIDGE_PORT in .env
const PLUGIN_NAME = "DiscordMcpBridge";

module.exports = class DiscordMcpBridge {
  constructor() {
    this.ws = null;
    this.reconnectTimer = null;
    this.reconnectDelay = 3000; // current backoff delay (ms), grows on failure
    this.stores = {};
    this.actions = {};
    // Port is loaded from persisted settings on start (fallback to default).
    this.port = DEFAULT_BRIDGE_PORT;
  }

  start() {
    // Load the persisted bridge port; fall back to the default.
    const saved = BdApi.Data.load(PLUGIN_NAME, "port");
    const parsed = parseInt(saved, 10);
    this.port = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_BRIDGE_PORT;
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
    // Private (DM / group DM) channel ordering store — best effort.
    this.stores.privateChannel =
      Webpack.getStore?.("PrivateChannelSortStore") ||
      byProps("getSortedPrivateChannels", "getPrivateChannelIds") ||
      byProps("getSortedPrivateChannels");
    // Threads store — best effort across versions.
    this.stores.threads =
      Webpack.getStore?.("ThreadsStore") ||
      Webpack.getStore?.("ActiveThreadsStore") ||
      byProps("getActiveJoinedThreadsForGuild", "getAllActiveThreadsForGuild") ||
      byProps("getAllActiveThreadsForGuild") ||
      byProps("getActiveJoinedThreadsForGuild");

    // Channel history fetch action: try several module signatures.
    this.actions.fetchMessages =
      byProps("fetchMessages", "receiveMessage") ||
      byProps("fetchMessages", "jumpToMessage") ||
      byProps("fetchMessages");
    // Server-wide search action creator. Discord's module shape has shifted
    // across versions, so try several resolution strategies in order.
    this.actions.search =
      byProps("searchMessages", "queryMessages") ||
      byProps("searchMessages", "clearSearch") ||
      byProps("searchMessages") ||
      // Function-property search: any module exposing a searchMessages fn.
      Webpack.getModule(
        (m) => m && typeof m.searchMessages === "function"
      ) ||
      // getByKeys-style fallback if available on this BdApi build.
      Webpack.getByKeys?.("searchMessages");
  }

  // --- WebSocket connection with auto-reconnect ---
  _connect() {
    const url = `ws://127.0.0.1:${this.port}`;
    try {
      this.ws = new WebSocket(url);
    } catch (e) {
      return this._scheduleReconnect();
    }
    this.ws.onopen = () => {
      // Successful connection resets the backoff delay.
      this.reconnectDelay = 3000;
      BdApi.UI.showToast("MCP bridge connected", { type: "success" });
    };
    this.ws.onclose = () => this._scheduleReconnect();
    this.ws.onerror = () => {};
    this.ws.onmessage = (ev) => this._onMessage(ev.data);
  }

  _scheduleReconnect() {
    if (this.reconnectTimer) return;
    const delay = this.reconnectDelay;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._connect();
    }, delay);
    // Capped exponential backoff: 3s, 6s, 12s, 24s, cap 30s.
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
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
    // Summarize a reply reference when the message is a reply.
    let referenced = null;
    const ref = m.referenced_message || m.messageReference;
    if (m.referenced_message) {
      const rm = m.referenced_message;
      referenced = {
        id: rm.id,
        author_username: rm.author?.username ?? null,
        content: rm.content ?? null,
      };
    } else if (ref && ref.message_id) {
      // Only the reference pointer is available (target not loaded).
      referenced = {
        id: ref.message_id,
        author_username: null,
        content: null,
      };
    }

    return {
      id: m.id,
      author: m.author
        ? { id: m.author.id, username: m.author.username }
        : null,
      content: m.content,
      timestamp: m.timestamp?.toString?.() ?? m.timestamp,
      edited_timestamp:
        m.editedTimestamp?.toString?.() ??
        m.edited_timestamp?.toString?.() ??
        m.editedTimestamp ??
        m.edited_timestamp ??
        null,
      pinned: !!m.pinned,
      attachments: (m.attachments || []).map((a) => ({
        filename: a.filename,
        url: a.url,
      })),
      // Trim embeds to the essentials to keep output small.
      embeds: (m.embeds || []).map((e) => ({
        title: e.rawTitle ?? e.title ?? null,
        description: e.rawDescription ?? e.description ?? null,
        url: e.url ?? null,
      })),
      reactions: (m.reactions || []).map((r) => ({
        emoji_name: r.emoji?.name ?? null,
        count: r.count ?? 0,
      })),
      referenced_message: referenced,
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

      fetchMessages: async ({ channelId, limit, before, authorId, after }) => {
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
        // Optional filter: only messages from a specific author.
        if (authorId) {
          msgs = msgs.filter((m) => m.author && m.author.id === authorId);
        }
        // Optional filter: only messages newer than `after` (snowflake).
        if (after) {
          const afterId = BigInt(after);
          msgs = msgs.filter((m) => {
            try {
              return BigInt(m.id) > afterId;
            } catch {
              return false;
            }
          });
        }
        // Discord keeps messages oldest-first — take the last `limit`
        // and return them newest-first.
        return msgs
          .slice(-limit)
          .reverse()
          .map((m) => this._fmtMessage(m));
      },

      searchMessages: async ({ guildId, query, limit }) => {
        // Resolve the search action creator defensively — the module may
        // expose searchMessages directly or nested under a property.
        const mod = this.actions.search;
        const searchFn =
          typeof mod?.searchMessages === "function"
            ? mod.searchMessages.bind(mod)
            : null;
        if (!searchFn) {
          throw new Error(
            "Search module not found in this Discord version (searchMessages unresolved)"
          );
        }
        const res = await searchFn({
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

      getMessageByLink: async ({ link }) => {
        if (!link || typeof link !== "string") {
          throw new Error("getMessageByLink requires a 'link' string");
        }
        // Accept discord.com, ptb./canary. subdomains and discordapp.com.
        const re =
          /https?:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/channels\/(\d+|@me)\/(\d+)\/(\d+)/;
        const match = link.match(re);
        if (!match) {
          throw new Error(`Malformed Discord message link: ${link}`);
        }
        const channelId = match[2];
        const messageId = match[3];

        let msg = this.stores.message.getMessage(channelId, messageId);
        if (!msg && this.actions.fetchMessages) {
          // Best-effort: load messages around the target, then re-read.
          const mod = this.actions.fetchMessages;
          const opts = { channelId, limit: 50, around: messageId };
          try {
            if (typeof mod.fetchMessages === "function") {
              await mod.fetchMessages(opts);
            } else {
              await mod(opts);
            }
            await this._sleep(800);
          } catch {
            // Ignore fetch failures; we retry the store read below.
          }
          msg = this.stores.message.getMessage(channelId, messageId);
        }
        if (!msg) {
          throw new Error(
            `Message ${messageId} not found in channel ${channelId}`
          );
        }
        return this._fmtMessage(msg);
      },

      getDMs: () => {
        const chStore = this.stores.channel;
        const pStore = this.stores.privateChannel;
        let channels = [];
        // Preferred: ordered private channels via the sort store.
        if (typeof pStore?.getSortedPrivateChannels === "function") {
          channels = pStore.getSortedPrivateChannels() || [];
        } else if (typeof pStore?.getPrivateChannelIds === "function") {
          const ids = pStore.getPrivateChannelIds() || [];
          channels = ids
            .map((id) => chStore?.getChannel?.(id))
            .filter(Boolean);
        } else if (typeof chStore?.getSortedPrivateChannels === "function") {
          channels = chStore.getSortedPrivateChannels() || [];
        } else {
          // Fallback: scan mutable channels for DM (1) / group DM (3) types.
          const all =
            chStore?.getMutablePrivateChannels?.() ||
            chStore?.getAllChannels?.() ||
            {};
          channels = Object.values(all).filter((c) =>
            [1, 3].includes(c.type)
          );
        }
        return channels.map((c) => {
          const recipients = (c.recipients || []).map((r) =>
            typeof r === "string"
              ? this.stores.user?.getUser?.(r)?.username ?? r
              : r?.username ?? r?.id
          );
          return {
            id: c.id,
            type: c.type,
            name: c.name || recipients.join(", "),
            recipients,
          };
        });
      },

      getThreads: ({ channelId, guildId } = {}) => {
        const ts = this.stores.threads;
        if (!ts) {
          throw new Error("Threads store not found in this Discord version");
        }
        let threads = [];
        // Try guild-wide active thread getters first.
        if (guildId && typeof ts.getAllActiveThreadsForGuild === "function") {
          const res = ts.getAllActiveThreadsForGuild(guildId) || {};
          threads = Array.isArray(res) ? res : Object.values(res).flat();
        } else if (
          guildId &&
          typeof ts.getActiveJoinedThreadsForGuild === "function"
        ) {
          const res = ts.getActiveJoinedThreadsForGuild(guildId) || {};
          // Shape: { channelId: { threadId: thread } }.
          threads = Object.values(res)
            .map((v) => Object.values(v || {}))
            .flat();
        } else if (
          channelId &&
          typeof ts.getActiveUnjoinedThreadsForParent === "function"
        ) {
          const res = ts.getActiveUnjoinedThreadsForParent(channelId) || {};
          threads = Array.isArray(res) ? res : Object.values(res);
        } else {
          throw new Error(
            "No compatible thread getter found; pass guildId or channelId"
          );
        }
        // Optionally narrow to a specific parent channel.
        if (channelId) {
          threads = threads.filter(
            (t) => t.parent_id === channelId || t.parentId === channelId
          );
        }
        return threads.map((t) => ({
          id: t.id,
          name: t.name,
          parent_id: t.parent_id ?? t.parentId ?? null,
          archived: !!(t.threadMetadata?.archived ?? t.archived),
        }));
      },

      getUserInfo: ({ userId }) => {
        const u = this.stores.user?.getUser?.(userId);
        if (!u) {
          throw new Error(`User ${userId} not found`);
        }
        return {
          id: u.id,
          username: u.username,
          global_name: u.globalName ?? u.global_name ?? null,
          bot: !!u.bot,
          avatar: u.avatar ?? null,
        };
      },

      ping: () => {
        // Lightweight health check that always returns.
        const s = this.stores;
        return {
          version: "0.3.0",
          modules: {
            guildStore: !!s.guild,
            channelStore: !!s.channel,
            messageStore: !!s.message,
            memberStore: !!s.member,
            userStore: !!s.user,
            fetchMessages: !!this.actions.fetchMessages,
            search: !!this.actions.search,
          },
        };
      },
    };
  }

  // --- Settings UI: lets the user change the bridge port ---
  getSettingsPanel() {
    const wrapper = document.createElement("div");
    wrapper.style.padding = "16px";
    wrapper.style.color = "var(--text-normal, #dcddde)";

    const label = document.createElement("label");
    label.textContent = "Bridge port";
    label.style.display = "block";
    label.style.marginBottom = "8px";
    label.style.fontWeight = "600";

    const input = document.createElement("input");
    input.type = "number";
    input.value = String(this.port);
    input.min = "1";
    input.max = "65535";
    input.style.width = "120px";
    input.style.padding = "6px 8px";
    input.style.marginRight = "8px";
    input.style.background = "var(--input-background, #202225)";
    input.style.color = "var(--text-normal, #dcddde)";
    input.style.border = "1px solid var(--background-tertiary, #202225)";
    input.style.borderRadius = "4px";

    const button = document.createElement("button");
    button.textContent = "Save & reconnect";
    button.style.padding = "6px 12px";
    button.style.background = "var(--brand-experiment, #5865f2)";
    button.style.color = "#fff";
    button.style.border = "none";
    button.style.borderRadius = "4px";
    button.style.cursor = "pointer";

    const hint = document.createElement("div");
    hint.textContent = `Default is ${DEFAULT_BRIDGE_PORT}. Must match BRIDGE_PORT in .env.`;
    hint.style.marginTop = "10px";
    hint.style.fontSize = "12px";
    hint.style.color = "var(--text-muted, #a3a6aa)";

    button.addEventListener("click", () => {
      const parsed = parseInt(input.value, 10);
      const port =
        Number.isFinite(parsed) && parsed > 0 && parsed <= 65535
          ? parsed
          : DEFAULT_BRIDGE_PORT;
      this.port = port;
      BdApi.Data.save(PLUGIN_NAME, "port", port);
      // Reconnect using the new port.
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      if (this.ws) {
        this.ws.onclose = null;
        this.ws.close();
        this.ws = null;
      }
      this.reconnectDelay = 3000;
      this._connect();
      BdApi.UI.showToast(`Bridge port set to ${port}`, { type: "success" });
    });

    wrapper.appendChild(label);
    wrapper.appendChild(input);
    wrapper.appendChild(button);
    wrapper.appendChild(hint);
    return wrapper;
  }
};
