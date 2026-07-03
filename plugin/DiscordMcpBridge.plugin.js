/**
 * @name DiscordMcpBridge
 * @author EncryRose
 * @description Bridge between the Discord client and a Python MCP server.
 *   Reads data from the authenticated client and exposes it to an AI agent.
 *   Self-bot tool — violates Discord ToS. Use at your own risk.
 * @version 0.5.0
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
    // Threads store — resolve by the parent-lookup getters it exposes.
    // These live on the store's prototype, so byProps (which reads the
    // property directly) picks them up where own-key scans would miss them.
    this.stores.threads =
      byProps("getThreadsForParent", "getAllThreadsForParent") ||
      byProps("getThreadsForParent") ||
      Webpack.getStore?.("ThreadsStore") ||
      Webpack.getStore?.("ActiveThreadsStore") ||
      byProps("getActiveJoinedThreadsForGuild", "getAllActiveThreadsForGuild") ||
      byProps("getAllActiveThreadsForGuild") ||
      byProps("getActiveJoinedThreadsForGuild");
    // Forum/thread loader action creator: loadArchivedThreads dispatches
    // LOAD_ARCHIVED_THREADS_SUCCESS which populates the threads store.
    this.actions.loadThreads =
      byProps("loadArchivedThreads", "loadThreadsBulk") ||
      byProps("loadArchivedThreads") ||
      null;

    // Pinned messages: ChannelPinsStore.getPins(channelId) holds the loaded
    // pins; the action creator's fetchPins() makes the REST call and
    // dispatches LOAD_PINNED_MESSAGES_SUCCESS to populate the store.
    this.stores.pins =
      Webpack.getStore?.("ChannelPinsStore") || byProps("getPins") || null;
    this.actions.pins =
      Webpack.getModule(
        (m) =>
          m &&
          typeof m.fetchPins === "function" &&
          typeof m.pinMessage === "function"
      ) || null;

    // Channel history fetch action: try several module signatures.
    this.actions.fetchMessages =
      byProps("fetchMessages", "receiveMessage") ||
      byProps("fetchMessages", "jumpToMessage") ||
      byProps("fetchMessages");
    // Server-wide search (native Flux path). Three pieces:
    //   1. the action creator module (fetchMessages + fetchTabMessages +
    //      clearSearchMessages siblings),
    //   2. the FluxDispatcher (dispatch/subscribe/unsubscribe — an export),
    //   3. the SearchType enum (string enum with GUILD/DMS members).
    // The action creator dispatches SEARCH_MESSAGES_SUCCESS on the dispatcher;
    // we subscribe to that to read results, since the underlying REST promise
    // does not settle from the plugin context.
    this.actions.search =
      Webpack.getModule(
        (m) =>
          m &&
          typeof m.fetchMessages === "function" &&
          typeof m.fetchTabMessages === "function" &&
          typeof m.clearSearchMessages === "function"
      ) || null;
    this.dispatcher =
      Webpack.getModule(
        (m) =>
          m &&
          typeof m.dispatch === "function" &&
          typeof m.subscribe === "function" &&
          typeof m.unsubscribe === "function",
        { searchExports: true }
      ) || null;
    this.searchType =
      Webpack.getModule(
        (m) => m && m.GUILD !== undefined && m.DMS !== undefined,
        { searchExports: true }
      ) || null;
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
          messageStore: !!s.message,
          memberStore: !!s.member,
          userStore: !!s.user,
          privateChannelStore: !!s.privateChannel,
          threadsStore: !!s.threads,
          fetchMessages: !!this.actions.fetchMessages,
          searchActionCreator: !!this.actions.search,
          dispatcher: !!this.dispatcher,
          searchType: this.searchType ? this.searchType.GUILD : null,
          loadArchivedThreads:
            typeof this.actions.loadThreads?.loadArchivedThreads === "function",
          getThreadsForParent:
            typeof s.threads?.getThreadsForParent === "function",
          pinsStore: !!s.pins,
          fetchPins: typeof this.actions.pins?.fetchPins === "function",
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
        const action = this.actions.search;
        const disp = this.dispatcher;
        const stype = this.searchType;
        if (!action || !disp || !stype) {
          throw new Error(
            "Search unavailable: the native search modules did not resolve " +
              "in this Discord version (action creator, dispatcher, or " +
              "SearchType enum missing)"
          );
        }

        const content = String(query || "").trim();
        if (!content) throw new Error("searchMessages requires a 'query'");
        const max = Math.min(limit || 25, 25); // Discord returns 25/page.

        // The action creator kicks off the request and, on success, dispatches
        // SEARCH_MESSAGES_SUCCESS with the results. The underlying REST promise
        // does not settle from the plugin context, so we listen on the flux
        // dispatcher for the outcome instead of awaiting a promise.
        const events = ["SUCCESS", "INDEXING", "FAILURE"].map(
          (s) => `SEARCH_MESSAGES_${s}`
        );
        let done = null; // { kind, payload }
        const subs = [];
        for (const name of events) {
          const cb = (payload) => {
            // Only accept events for our guild (SUCCESS carries guildId).
            if (name === "SEARCH_MESSAGES_SUCCESS") {
              if (payload?.guildId && payload.guildId !== guildId) return;
              if (!done) done = { kind: "SUCCESS", payload };
            } else if (name === "SEARCH_MESSAGES_INDEXING") {
              if (!done) done = { kind: "INDEXING", payload };
            } else if (name === "SEARCH_MESSAGES_FAILURE") {
              if (!done) done = { kind: "FAILURE", payload };
            }
          };
          try {
            disp.subscribe(name, cb);
            subs.push([name, cb]);
          } catch {
            /* ignore individual subscribe failures */
          }
        }
        const cleanup = () => {
          for (const [name, cb] of subs) {
            try {
              disp.unsubscribe(name, cb);
            } catch {
              /* ignore */
            }
          }
        };

        const searchContext = { type: stype.GUILD, guildId };
        // Retry loop: the guild's message index may still be building, in
        // which case we get INDEXING and should wait, then re-issue.
        try {
          const overallDeadline = Date.now() + 30000;
          let success = null;
          for (let attempt = 0; attempt < 4; attempt++) {
            done = null;
            try {
              action.fetchMessages({
                searchContext,
                searchQueryString: content,
                pagination: { offset: 0 },
                searchEverywhere: false,
              });
            } catch (e) {
              throw new Error(
                `Search call failed: ${e?.message || String(e)}`
              );
            }
            // Wait for one of the outcome events (or a per-attempt timeout).
            const attemptDeadline = Math.min(Date.now() + 12000, overallDeadline);
            while (Date.now() < attemptDeadline && !done) {
              await this._sleep(300);
            }
            if (done?.kind === "SUCCESS") {
              success = done.payload;
              break;
            }
            if (done?.kind === "FAILURE") {
              throw new Error(
                `Search failed: ${String(done.payload?.error).slice(0, 200)}`
              );
            }
            // INDEXING or timed out: brief pause, then retry.
            if (Date.now() >= overallDeadline) break;
            await this._sleep(2000);
          }

          if (!success) {
            throw new Error(
              "Search did not complete in time; the guild's message index " +
                "may still be building — try again shortly."
            );
          }

          const data = success.data?.[0];
          const groups = data?.messages || [];
          // Each group is [message, ...context]; the first entry is the hit.
          return groups
            .slice(0, max)
            .map((g) => (Array.isArray(g) ? g[0] : g))
            .filter(Boolean)
            .map((m) => ({
              ...this._fmtMessage(m),
              channel_id: m.channel_id,
            }));
        } finally {
          cleanup();
        }
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

      getThreads: async ({ channelId, guildId } = {}) => {
        const ts = this.stores.threads;
        if (!ts) {
          throw new Error("Threads store not found in this Discord version");
        }

        // Read active threads the store already holds, normalized to an array.
        const readActive = () => {
          if (channelId && typeof ts.getThreadsForParent === "function") {
            const res =
              ts.getThreadsForParent(channelId) ||
              ts.getAllThreadsForParent?.(channelId) ||
              {};
            return Array.isArray(res) ? res : Object.values(res);
          }
          if (guildId && typeof ts.getThreadsForGuild === "function") {
            const res = ts.getThreadsForGuild(guildId) || {};
            return Object.values(res)
              .map((v) => (v && typeof v === "object" ? Object.values(v) : v))
              .flat();
          }
          return null;
        };

        let threads = readActive();

        // Forum/archived posts don't live in the active store. Fetch them via
        // the action creator (Discord makes the REST call) and capture the
        // LOAD_ARCHIVED_THREADS_SUCCESS dispatch payload directly — same
        // pattern used for search. The payload carries the threads AND their
        // first message, so we attach a content preview to each post.
        let firstMessages = null;
        if (
          channelId &&
          (threads === null || threads.length === 0) &&
          this.dispatcher &&
          this.actions.loadThreads &&
          typeof this.actions.loadThreads.loadArchivedThreads === "function"
        ) {
          const ch = this.stores.channel?.getChannel?.(channelId);
          const gid = guildId || ch?.guild_id;
          const disp = this.dispatcher;
          let captured = null;
          const onSuccess = (payload) => {
            if (!payload || payload.channelId !== channelId) return;
            captured = payload;
          };
          disp.subscribe("LOAD_ARCHIVED_THREADS_SUCCESS", onSuccess);
          try {
            try {
              this.actions.loadThreads.loadArchivedThreads({
                guildId: gid,
                channelId,
                sortOrder: 0,
                tagFilter: new Set(),
                tagSetting: "match_some",
                offset: 0,
              });
            } catch {
              // Ignore synchronous throws; we poll for the dispatch below.
            }
            const deadline = Date.now() + 12000;
            while (Date.now() < deadline && !captured) {
              await this._sleep(300);
            }
          } finally {
            disp.unsubscribe("LOAD_ARCHIVED_THREADS_SUCCESS", onSuccess);
          }
          if (captured && Array.isArray(captured.threads)) {
            threads = captured.threads;
            // firstMessages: array of message objects; index by their channel_id
            // (a forum post's message channel_id equals the post/thread id).
            const fm = captured.firstMessages;
            if (Array.isArray(fm)) {
              firstMessages = {};
              for (const m of fm) {
                if (m && m.channel_id) firstMessages[m.channel_id] = m;
              }
            }
          }
        }

        if (threads === null) {
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
        return threads.map((t) => {
          const out = {
            id: t.id,
            name: t.name,
            parent_id: t.parent_id ?? t.parentId ?? null,
            archived: !!(t.threadMetadata?.archived ?? t.archived),
            message_count: t.messageCount ?? t.message_count ?? null,
          };
          const first = firstMessages?.[t.id];
          if (first) {
            out.first_message = {
              author:
                first.author?.global_name ||
                first.author?.username ||
                first.author?.id ||
                null,
              content: (first.content || "").slice(0, 500),
              timestamp: first.timestamp ?? null,
              attachments: (first.attachments || []).map((a) => a.url),
            };
          }
          return out;
        });
      },

      getPins: async ({ channelId }) => {
        if (!channelId) throw new Error("getPins requires a 'channelId'");
        const store = this.stores.pins;
        if (!store || typeof store.getPins !== "function") {
          throw new Error("Pins store not found in this Discord version");
        }

        const read = () => {
          const state = store.getPins(channelId);
          return state && Array.isArray(state.items) ? state.items : null;
        };

        let items = read();
        // Pins load lazily. If nothing cached and we have the loader, fetch and
        // wait for LOAD_PINNED_MESSAGES_SUCCESS to populate the store.
        if (
          (items === null || items.length === 0) &&
          this.actions.pins &&
          typeof this.actions.pins.fetchPins === "function" &&
          this.dispatcher
        ) {
          const disp = this.dispatcher;
          let done = false;
          const cb = (p) => {
            if (p && p.channelId === channelId) done = true;
          };
          disp.subscribe("LOAD_PINNED_MESSAGES_SUCCESS", cb);
          try {
            try {
              this.actions.pins.fetchPins(channelId, { reset: true, limit: 50 });
            } catch {
              // Ignore synchronous throws; poll for the dispatch below.
            }
            const deadline = Date.now() + 10000;
            while (Date.now() < deadline && !done) {
              await this._sleep(300);
            }
          } finally {
            disp.unsubscribe("LOAD_PINNED_MESSAGES_SUCCESS", cb);
          }
          items = read() || [];
        }

        if (items === null) items = [];
        // Each item is { pinnedAt, message }. Newest pins come first.
        return items.map((it) => ({
          pinned_at: it.pinnedAt?.toString?.() ?? it.pinnedAt ?? null,
          ...this._fmtMessage(it.message || it),
        }));
      },

      getChannelInfo: ({ channelId }) => {
        if (!channelId) throw new Error("getChannelInfo requires a 'channelId'");
        const c = this.stores.channel?.getChannel?.(channelId);
        if (!c) {
          throw new Error(`Channel ${channelId} not found in cache`);
        }
        return {
          id: c.id,
          name: c.name ?? null,
          type: c.type,
          guild_id: c.guild_id ?? null,
          parent_id: c.parent_id ?? null,
          topic: c.topic ?? null,
          nsfw: !!c.nsfw,
          // Thread-specific fields when this channel is a thread/forum post.
          owner_id: c.ownerId ?? c.owner_id ?? null,
          message_count: c.messageCount ?? c.message_count ?? null,
          member_count: c.memberCount ?? c.member_count ?? null,
          archived: c.threadMetadata?.archived ?? null,
          last_message_id: c.lastMessageId ?? c.last_message_id ?? null,
        };
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
          version: "0.5.0",
          modules: {
            guildStore: !!s.guild,
            channelStore: !!s.channel,
            messageStore: !!s.message,
            memberStore: !!s.member,
            userStore: !!s.user,
            fetchMessages: !!this.actions.fetchMessages,
            // Native Flux search: needs the action creator, the dispatcher,
            // and the SearchType enum together.
            search:
              !!this.actions.search && !!this.dispatcher && !!this.searchType,
            searchActionCreator: !!this.actions.search,
            dispatcher: !!this.dispatcher,
            searchType: this.searchType ? this.searchType.GUILD : null,
            threadsStore: !!s.threads,
            loadArchivedThreads:
              typeof this.actions.loadThreads?.loadArchivedThreads ===
              "function",
            pinsStore: !!s.pins,
            fetchPins: typeof this.actions.pins?.fetchPins === "function",
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
