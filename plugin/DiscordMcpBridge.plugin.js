/**
 * @name DiscordMcpBridge
 * @author EncryRose
 * @description Bridge between the Discord client and a Python MCP server.
 *   Reads data from the authenticated client and exposes it to an AI agent.
 *   Self-bot tool — violates Discord ToS. Use at your own risk.
 * @version 0.6.0
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
    // Port and managed guild are loaded from persisted settings on start.
    this.port = DEFAULT_BRIDGE_PORT;
    this.managedGuildId = null;
  }

  start() {
    // Load the persisted bridge port; fall back to the default.
    const saved = BdApi.Data.load(PLUGIN_NAME, "port");
    const parsed = parseInt(saved, 10);
    this.port = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_BRIDGE_PORT;
    // Guild that write/admin operations are restricted to. Set via
    // BdApi.Data.save("DiscordMcpBridge", "managedGuildId", "<guild id>").
    const g = BdApi.Data.load(PLUGIN_NAME, "managedGuildId");
    this.managedGuildId = /^\d{17,20}$/.test(String(g || "")) ? String(g) : null;
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

    // --- v0.6.0 stores ---
    // Roles: getRole/getRoles live on the store prototype.
    this.stores.role =
      store("RoleStore", "getRole", "getRoles") ||
      Webpack.getStore?.("GuildRoleStore") ||
      byProps("getRole", "getRoles") ||
      byProps("getRoles");
    // Custom emoji lookup (for humanize + reaction resolution).
    this.stores.emoji =
      byProps("getCustomEmoji", "getEmojiById") ||
      byProps("getCustomEmoji") ||
      Webpack.getStore?.("EmojiStore");
    // Presence store — approximate online count for guild info.
    this.stores.presence =
      Webpack.getStore?.("PresenceStore") ||
      byProps("getGuildPresenceCount") ||
      byProps("getPresences", "getGuildPresences");
    // Reactions store for getReactions. Reactors are loaded lazily; when the
    // store is empty we fall back to the internal HTTP module (below).
    this.stores.reactions =
      Webpack.getStore?.("ReactionsStore") ||
      byProps("getReactions", "getUserReactionIds") ||
      byProps("getReactions") ||
      null;
    this.actions.reactions =
      Webpack.getModule((m) => m && typeof m.fetchReactions === "function") ||
      null;
    this.actions.admin =
      Webpack.getModule(
        m => m && typeof m === "object" && typeof m.createRole === "function" && typeof m.kickUser === "function",
        { searchExports: true }
      ) || null;
    this.actions.guildSettings =
      Webpack.getModule(
        m => m && typeof m === "object" && typeof m.updateGuild === "function" && typeof m.saveGuild === "function",
        { searchExports: true }
      ) || null;
    this.actions.channelCreator =
      Webpack.getModule(
        m => m && typeof m === "object" && typeof m.createChannel === "function" && typeof m.createRoleSubscriptionTemplateChannel === "function",
        { searchExports: true }
      ) || null;
    this.actions.channelEditor =
      Webpack.getModule(
        m => m && typeof m === "object" && typeof m.updateChannel === "function" && typeof m.saveChannel === "function" && typeof m.deleteChannel === "function",
        { searchExports: true }
      ) || null;
    // Discord's real internal REST client is resolved lazily and verified
    // against /users/@me (see _resolveHttp). The auth token stays inside the
    // client and never leaves it.
    this.actions.http = null;
    this.actions.httpDel = null;
  }

  // Find Discord's authenticated REST client by probing /users/@me. Superagent
  // and other lookalikes also expose get/post/patch/put, so signature checks
  // are unreliable; only a live call that returns the current user is trusted.
  async _resolveHttp() {
    if (this.actions.http && typeof this.actions.httpDel === "function") {
      return this.actions.http;
    }
    const cands = BdApi.Webpack.getModules?.(
      m => m && typeof m === "object" &&
        ["get", "post", "patch", "put"].every(k => typeof m[k] === "function") &&
        (typeof m.del === "function" || typeof m.delete === "function"),
      { searchExports: true }
    ) || [];
    for (const c of cands) {
      try {
        const r = await Promise.race([
          c.get({ url: "/users/@me" }),
          new Promise((_, rej) => setTimeout(() => rej(new Error("probe timeout")), 6000)),
        ]);
        if (r?.body?.id && r?.body?.username) {
          this.actions.http = c;
          this.actions.httpDel = c.del || c.delete;
          return c;
        }
      } catch {
        /* not the authenticated client; try the next candidate */
      }
    }
    return null;
  }

  // --- Role lookup helper (v0.6.0) ---
  // Role storage moved across Discord versions: some builds expose
  // RoleStore.getRoles(guildId), others keep roles on GuildStore
  // (getRoles(guildId) or the guild record's `.roles` map). Try each and
  // return a { roleId: roleObject } map (possibly empty). Never throws.
  _getGuildRoles(guildId) {
    const r = this.stores.role;
    // Method names vary by version. getRoles(guildId) existed in older
    // builds; current builds expose getRolesSnapshot / getUnsafeMutableRoles
    // (a { roleId: role } map) or getSortedRoles (an array). Try each and
    // normalize to a { roleId: role } map.
    const sources = [
      () => r?.getRoles?.(guildId),
      () => r?.getRolesSnapshot?.(guildId),
      () => r?.getUnsafeMutableRoles?.(guildId),
      () => r?.getSortedRoles?.(guildId),
      () => this.stores.guild?.getGuild?.(guildId)?.roles,
    ];
    for (const get of sources) {
      let roles;
      try {
        roles = get();
      } catch {
        continue;
      }
      if (!roles) continue;
      // Normalize an array of role objects into a { id: role } map.
      if (Array.isArray(roles)) {
        if (!roles.length) continue;
        const map = {};
        for (const role of roles) if (role && role.id) map[role.id] = role;
        if (Object.keys(map).length) return map;
        continue;
      }
      if (typeof roles === "object" && Object.keys(roles).length) return roles;
    }
    return {};
  }

  // Channel map for a guild, trying the method names that vary by version.
  _guildChannelMap(guildId) {
    const st = this.stores.channel;
    if (!st) return {};
    try {
      return (
        st.getMutableGuildChannels?.() ||
        st.getMutableGuildChannelsForGuild?.(guildId) ||
        st.getAllChannels?.() ||
        {}
      );
    } catch {
      return {};
    }
  }

  // --- Humanize helper (v0.6.0) ---
  // Replace Discord entity mentions with readable text. Never throws; any
  // unresolved entity is left with its original syntax intact.
  _humanizeContent(content, { channelId, guildId } = {}) {
    if (!content || typeof content !== "string") return content;
    const re = /<#(\d+)>|<@!?(\d+)>|<@&(\d+)>|<a?:(\w+):(\d+)>/g;
    return content.replace(
      re,
      (whole, chId, userId, roleId, emojiName /*, emojiId */) => {
        try {
          if (chId) {
            const ch = this.stores.channel?.getChannel?.(chId);
            return ch?.name ? `#${ch.name}` : whole;
          }
          if (userId) {
            const u = this.stores.user?.getUser?.(userId);
            return u?.username ? `@${u.username}` : whole;
          }
          if (roleId) {
            if (!guildId) return whole; // DM / no guild context
            const roles = this.stores.role?.getRoles?.(guildId);
            const r = roles?.[roleId];
            return r?.name ? `@${r.name}` : whole;
          }
          if (emojiName) {
            return `:${emojiName}:`;
          }
        } catch {
          return whole;
        }
        return whole;
      }
    );
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
      const errStr = e?.message || (typeof e === "object" ? JSON.stringify(e) : String(e));
      reply({ ok: false, error: errStr });
    }
  }

  _dispatch(method, params) {
    if (method === "adminDiagnostics") {
      return this._adminDiagnostics();
    }
    if (method === "listAllChannels") {
      return this._listAllChannels(params);
    }
    if (method === "manageGuild") return this._manageGuild(params);
    const handlers = this._handlers();
    const fn = Object.hasOwn(handlers, method) ? handlers[method] : null;
    if (!fn) throw new Error(`Unknown method: ${method}`);
    return fn(params);
  }

  _managedGuildId() {
    if (!this.managedGuildId) throw new Error("managedGuildId not configured — set BdApi.Data.save(\"DiscordMcpBridge\", \"managedGuildId\", \"<guild id>\")");
    return this.managedGuildId;
  }

  // Compact full channel tree (all types) via the verified REST client.
  async _listAllChannels({ guildId }) {
    const managed = this._managedGuildId();
    if (guildId !== managed) throw new Error("Restricted to managed guild");
    const http = await this._resolveHttp();
    if (!http) throw new Error("Authenticated Discord HTTP module not verified");
    const r = await http.get({ url: `/guilds/${guildId}/channels` });
    if (!Array.isArray(r?.body)) throw new Error(`Unexpected response: ${r?.status}`);
    return r.body
      .map(c => ({ id: c.id, name: c.name, type: c.type, parent_id: c.parent_id ?? null, position: c.position ?? 0 }))
      .sort((a, b) => (a.type === 4 ? -1 : b.type === 4 ? 1 : 0) || a.position - b.position);
  }

  async _adminDiagnostics() {
    const guildId = this._managedGuildId();
    const user = this.stores.user?.getCurrentUser?.();
    const guild = this.stores.guild?.getGuild?.(guildId);
    const permissions = BdApi.Webpack.getStore?.("PermissionStore");
    let manageChannels = null;
    try { manageChannels = permissions?.can?.(16n, guild) ?? null; } catch {}
    let response;
    try {
      const hc = await this._resolveHttp();
      if (!hc) throw new Error("authenticated client not resolved");
      const r = await hc.get({ url: `/guilds/${guildId}/channels` });
      response = {
        status: r?.status ?? null,
        keys: r && typeof r === "object" ? Object.keys(r) : [],
        bodyType: Array.isArray(r?.body) ? "array" : typeof r?.body,
        textType: typeof r?.text,
        contentType: r?.headers?.["content-type"] ?? null,
        channels: Array.isArray(r?.body) ? r.body.map(c => ({id:c.id, name:c.name, type:c.type, parent_id:c.parent_id ?? null})) : null,
        errorCode: r?.body?.code ?? null,
        errorMessage: r?.body?.message ?? null,
      };
    } catch (e) {
      response = { status: e?.status ?? null, code: e?.body?.code ?? null, message: e?.body?.message ?? "HTTP read failed" };
    }
    return {
      diagnosticVersion: 2,
      authenticatedHttpResolved: !!(this.actions.http && typeof this.actions.http.del === "function"),
      httpCandidates: (BdApi.Webpack.getModules?.(m => m && ["get", "post", "patch", "put"].every(k => typeof m[k] === "function"), { searchExports: true }) || []).map(m => ({
        keys: Object.keys(m).filter(k => typeof m[k] === "function").slice(0, 12),
        getArity: m.get.length,
        hasApiBase: typeof m.getAPIBaseURL === "function",
        apiBase: (() => { try { return typeof m.getAPIBaseURL === "function" ? m.getAPIBaseURL() : null; } catch { return null; } })(),
      })).slice(0, 15),
      createStickerInfo: (() => {
        const m = BdApi.Webpack.getModule(m => m && (m.CREATE_STICKER || m.createSticker), { searchExports: true });
        return m ? { keys: Object.keys(m), values: Object.fromEntries(Object.entries(m).map(([k, v]) => [k, typeof v === "function" ? String(v).slice(0, 300) : v])) } : null;
      })(),
      adminCandidates: (BdApi.Webpack.getModules?.(m => m && typeof m === "object" && ["createChannel", "createRole", "updateGuild", "createGuildChannel", "createGuildRole"].some(k => typeof m[k] === "function"), { searchExports: true }) || []).map(m => ({
        keys: Object.keys(m).filter(k => typeof m[k] === "function").slice(0, 20),
      })).slice(0, 15),
      httpProbe: await (async () => {
        const cands = BdApi.Webpack.getModules?.(m => m && typeof m === "object" && typeof m.get === "function" && typeof m.post === "function" && typeof m.patch === "function" && typeof m.put === "function" && typeof m.del === "function", { searchExports: true }) || [];
        const out = [];
        for (let i = 0; i < Math.min(cands.length, 3); i++) {
          const c = cands[i];
          try {
            const r = await Promise.race([c.get({ url: "/users/@me" }), new Promise((_, rej) => setTimeout(() => rej(new Error("probe timeout")), 8000))]);
            out.push({ i, ct: r?.headers?.["content-type"] ?? null, status: r?.status ?? null, isUser: !!(r?.body?.id && r?.body?.username), username: r?.body?.username ?? null });
          } catch (e) {
            out.push({ i, error: String(e?.message || e).slice(0, 120) });
          }
        }
        return out;
      })(),
      channelEditorSig: (() => {
        const ce = this.actions.channelEditor;
        if (!ce) return null;
        return {
          open: ce.open.length, updateChannel: ce.updateChannel.length,
          saveChannel: ce.saveChannel.length, deleteChannel: ce.deleteChannel.length,
          updateChannelSrc: String(ce.updateChannel).slice(0, 300),
          saveChannelSrc: String(ce.saveChannel).slice(0, 1200),
          openSrc: String(ce.open).slice(0, 200),
        };
      })(),
      channelEditors: (BdApi.Webpack.getModules?.(m => m && typeof m === "object" && typeof m.updateChannel === "function" && typeof m.deleteChannel === "function", { searchExports: true }) || []).map(m => ({
        keys: Object.keys(m).filter(k => typeof m[k] === "function").slice(0, 20),
      })).slice(0, 10),
      currentUserId: user?.id ?? null,
      isOwner: !!user && user.id === (guild?.ownerId ?? guild?.owner_id),
      manageChannels,
      cachedChannels: Object.values(this._guildChannelMap(guildId)).filter(c => c.guild_id === guildId).map(c => ({id:c.id, name:c.name, type:c.type})),
      response,
    };
  }

  // Administrative writes use the client's own action creators; no raw HTTP.
  async _manageGuild({ guildId, operation, targetId, fields = {} }) {
    const managed = this._managedGuildId();
    if (guildId !== managed && !["list_emojis", "list_stickers"].includes(operation)) throw new Error("Writes restricted to managed guild");
    if (!fields || typeof fields !== "object") throw new Error("Invalid fields");
    const http = await this._resolveHttp();
    const del = this.actions.httpDel;
    if (!http || typeof http.get !== "function" || typeof del !== "function") throw new Error("Authenticated Discord HTTP module not verified; writes disabled");
    const specs = {
      create_channel: ["post", `/guilds/${guildId}/channels`, ["name", "type", "topic", "parent_id", "permission_overwrites", "rate_limit_per_user"]],
      update_channel: ["patch", `/channels/${targetId}`, ["name", "topic", "parent_id", "position", "permission_overwrites", "rate_limit_per_user", "user_limit"]],
      delete_channel: ["del", `/channels/${targetId}`, []],
      create_role: ["post", `/guilds/${guildId}/roles`, ["name", "permissions", "color", "hoist", "mentionable", "icon", "unicode_emoji"]],
      update_role: ["patch", `/guilds/${guildId}/roles/${targetId}`, ["name", "permissions", "color", "hoist", "mentionable", "icon", "unicode_emoji"]],
      delete_role: ["del", `/guilds/${guildId}/roles/${targetId}`, []],
      add_member_role: ["put", `/guilds/${guildId}/members/${targetId}/roles/${fields.role_id}`, ["role_id"]],
      remove_member_role: ["del", `/guilds/${guildId}/members/${targetId}/roles/${fields.role_id}`, ["role_id"]],
      timeout_member: ["patch", `/guilds/${guildId}/members/${targetId}`, ["communication_disabled_until"]],
      kick_member: ["del", `/guilds/${guildId}/members/${targetId}`, []],
      ban_member: ["put", `/guilds/${guildId}/bans/${targetId}`, []],
      unban_member: ["del", `/guilds/${guildId}/bans/${targetId}`, []],
      list_invites: ["get", `/guilds/${guildId}/invites`, []],
      create_invite: ["post", `/channels/${targetId}/invites`, ["max_age", "max_uses", "temporary", "unique"]],
      delete_invite: ["del", `/invites/${targetId}`, []],
      update_guild: ["patch", `/guilds/${guildId}`, ["name", "description", "verification_level", "default_message_notifications", "explicit_content_filter"]],
      reorder_roles: ["patch", `/guilds/${guildId}/roles`, ["roles"]],
      create_webhook: ["post", `/channels/${targetId}/webhooks`, ["name", "avatar"]],
      create_emoji: ["post", `/guilds/${guildId}/emojis`, ["name", "image", "roles", "file_path"]],
      list_emojis: ["get", `/guilds/${guildId}/emojis`, []],
      delete_emoji: ["del", `/guilds/${guildId}/emojis/${targetId}`, []],
      create_sticker: ["post", `/guilds/${guildId}/stickers`, ["name", "description", "tags", "file", "image", "file_path"]],
      list_stickers: ["get", `/guilds/${guildId}/stickers`, []],
      delete_sticker: ["del", `/guilds/${guildId}/stickers/${targetId}`, []],
    };
    if (!Object.hasOwn(specs, operation)) throw new Error("Unsupported operation");
    const [verb, url, allowed] = specs[operation];
    if (Object.keys(fields).some(k => !allowed.includes(k))) throw new Error("Unsupported fields");
    if (["create_channel", "update_channel", "create_role", "update_role", "update_guild", "create_emoji", "create_sticker"].includes(operation) && !Object.keys(fields).length) throw new Error("Empty fields");
    if (operation === "reorder_roles") {
      if (!Array.isArray(fields.roles) || !fields.roles.length) throw new Error("reorder_roles needs non-empty fields.roles array");
      const known = this._getGuildRoles(guildId);
      for (const e of fields.roles) {
        if (!e || typeof e !== "object") throw new Error("Each role entry must be an object");
        if (!/^\d{17,20}$/.test(String(e.id || ""))) throw new Error(`Invalid role id: ${e.id}`);
        if (!known[e.id]) throw new Error(`Role ${e.id} not in Exol cache`);
        if (e.position != null && !Number.isInteger(e.position)) throw new Error(`Invalid position for role ${e.id}`);
      }
    }
    if (operation === "timeout_member" && !Object.hasOwn(fields, "communication_disabled_until")) throw new Error("communication_disabled_until required");
    if (!["create_channel", "create_role", "update_guild", "list_invites", "delete_invite", "reorder_roles", "create_emoji", "list_emojis", "create_sticker", "list_stickers"].includes(operation)) {
      if (!/^\d{17,20}$/.test(targetId || "")) throw new Error("Invalid target id");
      if (["update_channel", "delete_channel", "create_invite", "create_webhook"].includes(operation) && this.stores.channel?.getChannel?.(targetId)?.guild_id !== guildId) throw new Error("Channel not in Exol cache");
      if (["update_role", "delete_role"].includes(operation) && !this._getGuildRoles(guildId)[targetId]) throw new Error("Role not in Exol cache");
      if (["add_member_role", "remove_member_role", "timeout_member", "kick_member"].includes(operation) && !this.stores.member?.getMember?.(guildId, targetId)) throw new Error("Member not in Exol cache");
    }
    if (["add_member_role", "remove_member_role"].includes(operation)) {
      if (!/^\d{17,20}$/.test(fields.role_id || "") || !this._getGuildRoles(guildId)[fields.role_id]) throw new Error("Invalid Exol role_id");
    }
    if (operation === "timeout_member") {
      const until = fields.communication_disabled_until;
      const ms = typeof until === "string" ? Date.parse(until) : NaN;
      if (until !== null && (!Number.isFinite(ms) || ms <= Date.now() || ms > Date.now() + 28 * 86400000)) throw new Error("Timeout must be within 28 days or null");
    }
    if (operation === "delete_channel") {
      const ch = this.stores.channel?.getChannel?.(targetId);
      if (["rules", "announcements", "welcome", "faq", "general"].includes(ch?.name?.toLowerCase())) throw new Error(`Refusing deletion of protected channel ${ch.name}`);
    }
    if (operation === "delete_invite") {
      const invite = await http.get({ url: `/invites/${targetId}` });
      if (invite?.body?.guild?.id !== guildId) throw new Error("Invite not verified as belonging to Exol");
    }
    if (fields.parent_id != null && this.stores.channel?.getChannel?.(fields.parent_id)?.guild_id !== guildId) throw new Error("Parent not in Exol");
    if (this.adminPending) throw new Error("Another administrative action is running");
    this.adminPending = true;
    try {
      try { BdApi.UI.showToast(`Exol MCP: ${operation}`, { type: "info" }); } catch {}
      const options = { url };
      if (verb === "post" || verb === "patch" || verb === "put") {
        if (operation === "create_sticker") {
          let rawB64 = (fields.file || fields.image || "").replace(/^data:image\/\w+;base64,/, "").trim();
          if (fields.file_path) {
            const fs = require("fs");
            rawB64 = fs.readFileSync(fields.file_path, "base64").trim();
          }
          const byteChars = atob(rawB64);
          const byteNumbers = new Uint8Array(byteChars.length);
          for (let i = 0; i < byteChars.length; i++) byteNumbers[i] = byteChars.charCodeAt(i);
          const blob = new Blob([byteNumbers], { type: "image/png" });
          const fd = new FormData();
          fd.append("name", fields.name);
          fd.append("description", fields.description || "");
          fd.append("tags", fields.tags || "exol");
          fd.append("file", blob, "sticker.png");
          options.body = fd;
        } else if (operation === "create_emoji") {
          let img = fields.image;
          if (fields.file_path) {
            const fs = require("fs");
            const buf = fs.readFileSync(fields.file_path);
            img = `data:image/png;base64,${buf.toString("base64")}`;
          }
          options.body = { name: fields.name, image: img, roles: fields.roles || [] };
        } else if (operation === "reorder_roles") {
          options.body = fields.roles.map(e => ({ id: e.id, position: e.position }));
        } else {
          const body = { ...fields };
          delete body.role_id;
          options.body = body;
        }
      }
      const fn = verb === "del" ? del : http[verb];
      const response = await fn(options);
      const status = response?.status ?? null;
      if (!status || status < 200 || status >= 300) {
        throw new Error(`Discord returned ${status}: ${JSON.stringify(response?.body ?? null).slice(0, 300)}`);
      }
      const b = response.body;
      const slim = b && typeof b === "object" && !Array.isArray(b)
        ? Object.fromEntries(Object.entries(b).filter(([k]) => ["id", "name", "type", "parent_id", "position", "code", "message", "permissions", "token", "channel_id", "url"].includes(k)))
        : (Array.isArray(b) ? b.map(x => ({ id: x?.id, name: x?.name, position: x?.position, permissions: x?.permissions != null ? String(x.permissions) : undefined, type: x?.type, parent_id: x?.parent_id ?? null, description: x?.description, tags: x?.tags, animated: x?.animated })) : b);
      return { operation, guild_id: guildId, status, result: slim ?? null };
    } finally { this.adminPending = false; }
  }

  // --- Formatting helpers ---

  // Human-readable text for Discord system messages (joins, boosts, pins,
  // etc.). These carry an empty `content`; the client renders text from the
  // message `type`. Returns null for normal messages (type 0 / 19).
  _systemText(m) {
    const t = m.type;
    if (t === 0 || t === 19 || t == null) return null; // DEFAULT / REPLY
    const who = m.author?.username ?? "Someone";
    switch (t) {
      case 1:
        return `${who} added someone to the group.`;
      case 2:
        return `${who} removed someone / left the group.`;
      case 3:
        return `${who} started a call.`;
      case 4:
        return `${who} changed the channel name: ${m.content || ""}`.trim();
      case 5:
        return `${who} changed the channel icon.`;
      case 6:
        return `${who} pinned a message to this channel.`;
      case 7:
        // USER_JOIN: the client picks one of these deterministically from the
        // message creation timestamp. Reproduce the same selection.
        return this._joinMessage(m, who);
      case 8:
        return `${who} just boosted the server!`;
      case 9:
      case 10:
      case 11: {
        const tier = t - 8; // 9->1, 10->2, 11->3
        return `${who} just boosted the server! The server has achieved Level ${tier}!`;
      }
      case 12:
        return `${who} has added this channel to their feed.`;
      case 18:
        return `${who} started a thread: ${m.content || ""}`.trim();
      case 21:
        return `${who} started a thread.`;
      case 46:
        return `Poll: ${m.content || ""}`.trim();
      default:
        return `[system message type ${t}]${m.content ? " " + m.content : ""}`;
    }
  }

  // Reproduce Discord's deterministic USER_JOIN message selection. The client
  // indexes a fixed list by (snowflake creation ms % list length).
  _joinMessage(m, who) {
    const templates = [
      "%user% joined the party.",
      "%user% is here.",
      "Welcome, %user%. We hope you brought pizza.",
      "A wild %user% appeared.",
      "%user% just landed.",
      "%user% just slid into the server.",
      "%user% just showed up!",
      "Welcome %user%. Say hi!",
      "%user% hopped into the server.",
      "Everyone welcome %user%!",
      "Glad you're here, %user%.",
      "Good to see you, %user%.",
      "Yay you made it, %user%!",
    ];
    let idx = 0;
    try {
      // Discord snowflake: creation ms = (id >> 22) + epoch. The client uses
      // the creation timestamp in ms modulo the template count.
      const created = (BigInt(m.id) >> 22n) + 1420070400000n;
      idx = Number(created % BigInt(templates.length));
    } catch {
      idx = 0;
    }
    return templates[idx].replace("%user%", who);
  }

  _fmtMessage(m, opts) {
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

    const systemText = this._systemText(m);

    const out = {
      id: m.id,
      author: m.author
        ? { id: m.author.id, username: m.author.username }
        : null,
      content: m.content,
      // Message type (0 = normal, 19 = reply; anything else is a system
      // message such as a join or boost) plus its rendered text.
      type: m.type ?? null,
      system_text: systemText,
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

    // v0.6.0: optionally add a human-readable rendering of the content
    // (mentions/channels/roles/custom-emoji resolved). Additive only —
    // never replaces `content`.
    if (opts && opts.humanize) {
      const ch = this.stores.channel?.getChannel?.(m.channel_id);
      const guildId = opts.guildId ?? ch?.guild_id ?? null;
      out.content_human = this._humanizeContent(m.content, {
        channelId: m.channel_id,
        guildId,
      });
    }

    return out;
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
          roleStore: !!this.stores.role,
          emojiStore: !!this.stores.emoji,
          presenceStore: !!this.stores.presence,
          reactionsStore: !!this.stores.reactions,
          fetchReactions: !!this.actions.reactions,
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
          .filter((c) => c.guild_id === guildId && [0, 2, 4, 5].includes(c.type))
          .map((c) => ({
            id: c.id,
            name: c.name,
            type: c.type,
            topic: c.topic || null,
          }));
      },

      getMembers: ({ guildId, includeRoleNames }) => {
        const members = this.stores.member.getMembers(guildId) || [];
        // Optional role-id → role-name map, built once when requested.
        let roleMap = null;
        if (includeRoleNames === true) {
          const roles = this._getGuildRoles(guildId);
          if (roles && Object.keys(roles).length) {
            roleMap = {};
            for (const r of Object.values(roles)) {
              if (r && r.id) roleMap[r.id] = r.name ?? null;
            }
          }
        }
        return members.map((m) => {
          const out = {
            id: m.userId,
            username: this.stores.user?.getUser?.(m.userId)?.username ?? null,
            nick: m.nick || null,
            roles: m.roles || [],
          };
          if (includeRoleNames === true) {
            out.role_names = (m.roles || []).map((rid) =>
              roleMap ? roleMap[rid] ?? null : null
            );
          }
          return out;
        });
      },

      fetchMessages: async ({
        channelId,
        limit,
        before,
        authorId,
        after,
        humanize,
      }) => {
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
        const fmtOpts = humanize ? { humanize: true } : undefined;
        return msgs
          .slice(-limit)
          .reverse()
          .map((m) => this._fmtMessage(m, fmtOpts));
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
          permission_overwrites: c.permissionOverwrites ?? c.permission_overwrites ?? null,
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

      getRoles: ({ guildId }) => {
        const roles = this._getGuildRoles(guildId);
        return Object.values(roles)
          .filter((r) => r && r.id)
          .map((r) => ({
            id: r.id,
            name: r.name ?? null,
            color: r.color ?? 0,
            position: r.position ?? 0,
            icon: r.icon ?? null,
            unicode_emoji: r.unicode_emoji ?? r.unicodeEmoji ?? null,
            hoist: !!r.hoist,
            mentionable: !!r.mentionable,
            // permissions is a BigInt — stringify to preserve precision.
            permissions: String(r.permissions ?? 0n),
          }));
      },

      getGuildExpressions: async ({ guildId }) => {
        const http = await this._resolveHttp();
        let emojis = [];
        let stickers = [];
        try {
          const r = await http.get({ url: `/guilds/${guildId}/emojis` });
          emojis = (r?.body || []).map(e => ({ id: e.id, name: e.name, animated: !!e.animated }));
        } catch (e) {
          emojis = [{ error: String(e?.message || e) }];
        }
        try {
          const r = await http.get({ url: `/guilds/${guildId}/stickers` });
          stickers = (r?.body || []).map(s => ({ id: s.id, name: s.name, description: s.description, tags: s.tags, format_type: s.format_type }));
        } catch (e) {
          stickers = [{ error: String(e?.message || e) }];
        }
        return { guildId, emojis, stickers };
      },

      getGuildInfo: ({ guildId }) => {
        const g = this.stores.guild?.getGuild?.(guildId);
        if (!g) throw new Error(`Guild ${guildId} not found`);

        let creationMs = null;
        try {
          creationMs = Number((BigInt(g.id) >> 22n) + 1420070400000n);
        } catch {
          creationMs = null;
        }

        // Count channels/categories from the mutable guild-channel map.
        let channelsCount = 0;
        let categoriesCount = 0;
        try {
          const all = this._guildChannelMap(guildId);
          for (const c of Object.values(all)) {
            if (!c || c.guild_id !== guildId) continue;
            if (c.type === 4) categoriesCount++;
            else if (c.type === 0 || c.type === 5) channelsCount++;
          }
        } catch {
          /* leave counts at zero on failure */
        }

        let presenceCount = null;
        try {
          if (typeof this.stores.presence?.getGuildPresenceCount === "function") {
            presenceCount =
              this.stores.presence.getGuildPresenceCount(guildId) ?? null;
          }
        } catch {
          presenceCount = null;
        }

        return {
          id: g.id,
          name: g.name ?? null,
          owner_id: g.ownerId ?? g.owner_id ?? null,
          member_count: g.memberCount ?? g.member_count ?? null,
          presence_count: presenceCount,
          creation_date_ms: creationMs,
          features: g.features ? Array.from(g.features) : [],
          premium_tier: g.premiumTier ?? g.premium_tier ?? 0,
          premium_subscription_count:
            g.premiumSubscriberCount ??
            g.premium_subscription_count ??
            null,
          roles_count: Object.keys(this._getGuildRoles(guildId)).length,
          channels_count: channelsCount,
          categories_count: categoriesCount,
          icon: g.icon ?? null,
        };
      },

      resolveId: ({ id }) => {
        if (!id) throw new Error("resolveId requires an 'id'");
        // Try guild → user → channel. Never throw for unknown; put a hint in
        // `error`. Message IDs can't be classified without a channelId.
        try {
          const g = this.stores.guild?.getGuild?.(id);
          if (g) {
            return {
              type: "guild",
              id,
              brief: g.name ?? null,
              details: {
                id: g.id,
                name: g.name ?? null,
                owner_id: g.ownerId ?? g.owner_id ?? null,
              },
              error: null,
            };
          }
        } catch {
          /* fall through */
        }
        try {
          const u = this.stores.user?.getUser?.(id);
          if (u) {
            return {
              type: "user",
              id,
              brief: u.username ?? null,
              details: {
                id: u.id,
                username: u.username ?? null,
                global_name: u.globalName ?? u.global_name ?? null,
                bot: !!u.bot,
              },
              error: null,
            };
          }
        } catch {
          /* fall through */
        }
        try {
          const ch = this.stores.channel?.getChannel?.(id);
          if (ch) {
            return {
              type: ch.type === 11 ? "thread" : "channel",
              id,
              brief: ch.name ?? null,
              details: {
                id: ch.id,
                name: ch.name ?? null,
                type: ch.type,
                guild_id: ch.guild_id ?? null,
                parent_id: ch.parent_id ?? null,
              },
              error: null,
            };
          }
        } catch {
          /* fall through */
        }
        return {
          type: "unknown",
          id,
          brief: null,
          details: null,
          error:
            "Not a guild, user, or cached channel. If this is a message id, " +
            "use get_messages with its channelId (message ids can't be " +
            "resolved on their own).",
        };
      },

      getReactions: async ({ channelId, messageId, emoji }) => {
        if (!channelId || !messageId || !emoji) {
          throw new Error(
            "getReactions requires 'channelId', 'messageId' and 'emoji'"
          );
        }
        const store = this.stores.reactions;
        if (!store || typeof store.getReactions !== "function") {
          throw new Error("Reactions store not found in this Discord version");
        }

        // `emoji` may be a unicode char (👍) or a custom-emoji snowflake id.
        const isCustom = /^\d+$/.test(String(emoji));
        // ReactionsStore.getReactions(channelId, messageId, emojiObj) requires
        // an emoji object {name, id}; a 2-arg call throws. For custom emoji the
        // id matters; for unicode the name is the char itself.
        const emojiObj = isCustom
          ? { name: null, id: String(emoji) }
          : { name: String(emoji), id: null };

        // Store returns a Map (iterated as [userId, userObj] entries) or a
        // plain object. Normalize to a list of { id, username }.
        const read = () => {
          let raw = null;
          try {
            raw = store.getReactions(channelId, messageId, emojiObj);
          } catch {
            raw = null;
          }
          if (!raw) return [];
          let entries;
          if (raw instanceof Map) entries = [...raw.entries()];
          else if (Array.isArray(raw)) entries = raw;
          else entries = Object.entries(raw);

          const users = [];
          const seen = new Set();
          for (const entry of entries) {
            // entry is [uid, userObj], or a bare userObj/uid.
            let uid = null;
            let userObj = null;
            if (Array.isArray(entry)) {
              uid = entry[0];
              userObj = entry[1];
            } else if (typeof entry === "string") {
              uid = entry;
            } else if (entry && typeof entry === "object") {
              uid = entry.id ?? entry.userId ?? null;
              userObj = entry;
            }
            if (!uid || seen.has(uid)) continue;
            seen.add(uid);
            users.push({
              id: String(uid),
              username:
                userObj?.username ??
                this.stores.user?.getUser?.(uid)?.username ??
                null,
            });
          }
          return users;
        };

        let users = read();
        if (users.length) return users;

        // Not cached — Discord loads reactors lazily (on UI hover). This build
        // exposes no fetchReactions action, so fall back to the client's
        // internal REST module. The auth token stays inside the client; it is
        // never sent to the Python side.
        const http = this.actions.http;
        if (http && typeof http.get === "function") {
          // Build the emoji path segment: "name:id" for custom, encoded char
          // for unicode.
          const emojiParam = isCustom
            ? `name:${emoji}` // caller passed an id but Discord wants name:id;
            : encodeURIComponent(String(emoji));
          const path =
            `/channels/${channelId}/messages/${messageId}` +
            `/reactions/${emojiParam}?limit=100`;
          try {
            const res = await http.get({ url: path });
            const body = res?.body;
            if (Array.isArray(body)) {
              return body
                .filter((u) => u && u.id)
                .map((u) => ({
                  id: String(u.id),
                  username: u.username ?? null,
                }));
            }
          } catch {
            // REST failed (bad emoji param, rate-limit, etc.) — return what we
            // have rather than throwing.
          }
        }
        return users;
      },

      getThreadsPaginated: async ({
        channelId,
        guildId,
        offset,
        limit,
      } = {}) => {
        const off = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0;
        const lim = Math.min(
          Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 50,
          250
        );

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

        // Archived/forum posts: capture LOAD_ARCHIVED_THREADS_SUCCESS.
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

        // Narrow to a specific parent channel BEFORE paginating.
        if (channelId) {
          threads = threads.filter(
            (t) => t.parent_id === channelId || t.parentId === channelId
          );
        }

        const capturedTotal = threads.length;
        const sliced = threads.slice(off, off + lim);
        const mapped = sliced.map((t) => {
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

        return {
          threads: mapped,
          hasMore: sliced.length === lim && off + lim < capturedTotal,
          // Discord gives no canonical total; expose the captured count.
          total: capturedTotal,
        };
      },

      ping: () => {
        // Lightweight health check that always returns.
        const s = this.stores;
        return {
          version: "0.6.0",
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
            roleStore: !!this.stores.role,
            emojiStore: !!this.stores.emoji,
            presenceStore: !!this.stores.presence,
            reactionsStore: !!this.stores.reactions,
            fetchReactions: !!this.actions.reactions,
            // Internal REST client — powers the get_reactions fallback when
            // reactors aren't cached. Auth token stays in the client.
            httpClient: typeof this.actions.http?.get === "function",
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
