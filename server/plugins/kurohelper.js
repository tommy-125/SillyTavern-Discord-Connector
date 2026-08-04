/** Authenticated transport between KuroHelper and the tokenless AI Runtime. */

"use strict";

const WebSocket = require("ws");
const {
  listMemories,
  getMemory,
  forgetMemory,
  restoreMemory,
  clearMemories,
  listBackups,
  createBackup,
  restoreBackup,
} = require("../memory-client");

const PROTOCOL_VERSION = 1;
const configuredRequestCacheTtl = Number.parseInt(
  process.env.KUROHELPER_REQUEST_CACHE_TTL_SECONDS || "600",
  10,
);
const REQUEST_CACHE_TTL_MS =
  (Number.isFinite(configuredRequestCacheTtl) && configuredRequestCacheTtl > 0
    ? configuredRequestCacheTtl
    : 600) * 1000;
const REQUEST_CACHE_MAX = 1000;

function createKuroHelperPlugin(handlers, pluginConfig = {}) {
  const port = Number.parseInt(
    process.env.KUROHELPER_API_PORT || pluginConfig.port || "2334",
    10,
  );
  const host = process.env.KUROHELPER_API_HOST || pluginConfig.host || "0.0.0.0";
  const secret = String(
    process.env.KUROHELPER_BRIDGE_SECRET || pluginConfig.secret || "",
  ).trim();
  let server = null;
  let activeSocket = null;
  const pendingByRequest = new Map();
  const pendingByChat = new Map();
  const outputByRequest = new Map();
  const completedByRequest = new Map();

  function send(socket, type, requestId, payload = null, error = null) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify({
      version: PROTOCOL_VERSION,
      type,
      ...(requestId ? { requestId } : {}),
      ...(payload == null ? {} : { payload }),
      ...(error ? { error } : {}),
    }));
    return true;
  }

  function fail(socket, requestId, code, message) {
    send(socket, "error_response", requestId, null, { code, message });
  }

  function normalizeImages(images) {
    if (!Array.isArray(images)) return [];
    const allowedSourceKinds = new Set(["current", "reply", "recent"]);
    return images.slice(0, 4).map((image) => {
      const sourceKind = String(image?.sourceKind || "").trim().toLowerCase();
      return {
        id: String(image?.id || "").slice(0, 100),
        url: String(image?.url || "").trim().slice(0, 2048),
        filename: String(image?.filename || "").slice(0, 255),
        contentType: String(image?.contentType || "").slice(0, 100),
        size: Math.max(0, Math.min(Number(image?.size) || 0, 10 * 1024 * 1024)),
        messageId: String(image?.messageId || "").slice(0, 100),
        authorName: String(image?.authorName || "").slice(0, 100),
        sourceKind: allowedSourceKinds.has(sourceKind) ? sourceKind : "",
        sourceMessageText: String(image?.sourceMessageText || "")
          .replace(/[\u0000-\u001f\u007f]/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 1500),
        contextOnly: image?.contextOnly === true,
      };
    }).filter((image) => image.url);
  }

  function requestFingerprint(channelId, userId, text, images = []) {
    return JSON.stringify([
      String(channelId),
      String(userId),
      String(text),
      images.map((image) => [image.id, image.url]),
    ]);
  }

  function pruneRequestCache(now = Date.now()) {
    for (const [requestId, completed] of completedByRequest) {
      if (completed.expiresAt > now && completedByRequest.size <= REQUEST_CACHE_MAX) break;
      completedByRequest.delete(requestId);
    }
    for (const [requestId, pending] of pendingByRequest) {
      if (pending.expiresAt <= now) untrackRequest(requestId);
    }
  }

  function trackRequest(requestId, chatId, socket, fingerprint) {
    pendingByRequest.set(requestId, {
      requestId,
      chatId,
      socket,
      fingerprint,
      expiresAt: Date.now() + REQUEST_CACHE_TTL_MS,
    });
    if (!pendingByChat.has(chatId)) pendingByChat.set(chatId, []);
    pendingByChat.get(chatId).push(requestId);
  }

  function untrackRequest(requestId) {
    const pending = pendingByRequest.get(requestId);
    if (!pending) return null;
    pendingByRequest.delete(requestId);
    outputByRequest.delete(requestId);
    const queue = pendingByChat.get(pending.chatId) || [];
    const index = queue.indexOf(requestId);
    if (index >= 0) queue.splice(index, 1);
    if (queue.length === 0) pendingByChat.delete(pending.chatId);
    return pending;
  }

  function findPending(chatId, requestId = "") {
    if (requestId && pendingByRequest.has(requestId)) {
      return pendingByRequest.get(requestId);
    }
    const queue = pendingByChat.get(String(chatId || "")) || [];
    return queue.length > 0 ? pendingByRequest.get(queue[0]) : null;
  }

  function completeRequest(pending, type, payload = null, error = null) {
    if (!pending) return false;
    const completed = {
      type,
      payload,
      error,
      fingerprint: pending.fingerprint,
      expiresAt: Date.now() + REQUEST_CACHE_TTL_MS,
    };
    completedByRequest.set(pending.requestId, completed);
    pruneRequestCache();
    const delivered = send(pending.socket, type, pending.requestId, payload, error);
    untrackRequest(pending.requestId);
    return delivered;
  }

  async function handleMemory(socket, message) {
    const request = message.payload || {};
    let result;
    switch (request.action) {
      case "list":
        result = await listMemories({
          status: request.status === "deleted" ? "deleted" : "active",
          limit: Math.max(1, Math.min(Number(request.limit) || 20, 50)),
          offset: Math.max(0, Math.min(Number(request.offset) || 0, 1_000_000)),
        });
        break;
      case "get":
        result = await getMemory(String(request.memoryId || ""));
        break;
      case "forget":
        result = await forgetMemory(String(request.memoryId || ""));
        break;
      case "restore":
        result = await restoreMemory(String(request.memoryId || ""));
        break;
      case "clear":
        result = await clearMemories();
        break;
      case "backup_list":
        result = await listBackups({
          limit: Math.max(1, Math.min(Number(request.limit) || 20, 50)),
          offset: Math.max(0, Math.min(Number(request.offset) || 0, 1_000_000)),
        });
        break;
      case "backup_create":
        result = await createBackup();
        break;
      case "backup_restore":
        result = await restoreBackup(String(request.backupId || ""));
        break;
      default:
        fail(socket, message.requestId, "invalid_action", "Unknown memory action.");
        return;
    }
    send(socket, "memory_response", message.requestId, result);
  }

  async function handlePacket(socket, raw) {
    let message;
    try {
      message = JSON.parse(raw.toString("utf8"));
    } catch {
      fail(socket, "", "invalid_json", "Packet must be valid JSON.");
      return;
    }
    if (
      message?.version !== PROTOCOL_VERSION ||
      typeof message.type !== "string" ||
      typeof message.requestId !== "string" ||
      !message.requestId
    ) {
      fail(socket, message?.requestId || "", "invalid_envelope", "Invalid protocol envelope.");
      return;
    }
    pruneRequestCache();

    if (message.type === "health_request") {
      send(socket, "health_response", message.requestId, {
        status: handlers.isSillyTavernReady() ? "ready" : "degraded",
        sillyTavernReady: handlers.isSillyTavernReady(),
        memoryEnabled: process.env.MEMORY_ENABLED !== "false",
        trashRetentionDays: Number(process.env.MEMORY_TRASH_RETENTION_DAYS) || 30,
        visionCache: typeof handlers.getVisionCacheStats === "function"
          ? handlers.getVisionCacheStats()
          : null,
      });
      return;
    }
    if (message.type === "memory_request") {
      try {
        await handleMemory(socket, message);
      } catch (error) {
        fail(socket, message.requestId, "memory_unavailable", error.message);
      }
      return;
    }
    if (message.type === "raw_replies_request") {
      if (!handlers.isSillyTavernReady()) {
        fail(socket, message.requestId, "runtime_not_ready", "SillyTavern is not connected.");
        return;
      }
      try {
        const channelId = String(message.payload?.channelId || "").trim();
        if (!channelId) {
          fail(socket, message.requestId, "invalid_request", "channelId is required.");
          return;
        }
        const result = await handlers.listRawReplies(message.requestId, channelId);
        send(socket, "raw_replies_response", message.requestId, result);
      } catch (error) {
        fail(socket, message.requestId, "raw_replies_unavailable", error.message);
      }
      return;
    }
    if (message.type !== "generate_request") {
      fail(socket, message.requestId, "unknown_type", "Unknown request type.");
      return;
    }

    const payload = message.payload || {};
    const channelId = String(payload.channelId || "").trim();
    const userId = String(payload.userId || "").trim();
    const text = String(payload.text || "").trim();
    const images = normalizeImages(payload.images);
    if (Array.isArray(payload.images) && payload.images.length > 0) {
      handlers.log(
        "log",
        `[KuroHelper] Request ${message.requestId.slice(-8)} received ${payload.images.length} attachment(s); ${images.length} accepted for Vision.`,
      );
    }
    if (!channelId || !userId || !text) {
      fail(socket, message.requestId, "invalid_request", "channelId, userId and text are required.");
      return;
    }
    const fingerprint = requestFingerprint(channelId, userId, text, images);
    const completed = completedByRequest.get(message.requestId);
    if (completed) {
      if (completed.fingerprint !== fingerprint) {
        fail(socket, message.requestId, "request_id_conflict", "Request ID was already used for different content.");
        return;
      }
      send(socket, completed.type, message.requestId, completed.payload, completed.error);
      return;
    }
    const existing = pendingByRequest.get(message.requestId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        fail(socket, message.requestId, "request_id_conflict", "Request ID is already running with different content.");
        return;
      }
      existing.socket = socket;
      existing.expiresAt = Date.now() + REQUEST_CACHE_TTL_MS;
      return;
    }
    if (!handlers.isSillyTavernReady()) {
      fail(socket, message.requestId, "runtime_not_ready", "SillyTavern is not connected.");
      return;
    }

    trackRequest(message.requestId, channelId, socket, fingerprint);
    try {
      const accepted = await handlers.onUserMessage(
        "kurohelper",
        channelId,
        text,
        userId,
        {
          requestId: message.requestId,
          displayName: String(payload.displayName || ""),
          mentionedUsers: Array.isArray(payload.mentionedUsers)
            ? payload.mentionedUsers.slice(0, 25)
            : [],
          contextParticipants: Array.isArray(payload.contextParticipants)
            ? payload.contextParticipants.slice(0, 25)
            : [],
          recentChannelContext: String(payload.recentChannelContext || ""),
          recentMessages: Array.isArray(payload.recentMessages)
            ? payload.recentMessages.slice(0, 50)
            : [],
          retrievalText: String(payload.retrievalText || ""),
          images,
        },
      );
      if (!accepted) {
        untrackRequest(message.requestId);
        fail(socket, message.requestId, "runtime_not_ready", "SillyTavern rejected the request.");
      }
    } catch (error) {
      untrackRequest(message.requestId);
      fail(socket, message.requestId, "dispatch_failed", error.message);
    }
  }

  return {
    platform: "kurohelper",

    async start() {
      if (!secret) throw new Error("KUROHELPER_BRIDGE_SECRET is required.");
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error("KUROHELPER_API_PORT must be a valid TCP port.");
      }
      server = new WebSocket.Server({
        host,
        port,
        maxPayload: 1024 * 1024,
        verifyClient(info, done) {
          const authorization = String(info.req.headers.authorization || "");
          const allowed = authorization === `Bearer ${secret}`;
          if (allowed) {
            done(true);
          } else {
            done(false, 401, "Unauthorized");
          }
        },
      });
      server.on("connection", (socket) => {
        if (activeSocket && activeSocket.readyState === WebSocket.OPEN) {
          activeSocket.close(1008, "Replaced by a newer KuroHelper connection");
        }
        activeSocket = socket;
        handlers.log("log", `[KuroHelper] Bot connected on port ${port}.`);
        socket.on("message", (raw) => {
          handlePacket(socket, raw).catch((error) =>
            handlers.log("warn", `[KuroHelper] Packet failed: ${error.message}`),
          );
        });
        socket.on("close", () => {
          if (activeSocket === socket) activeSocket = null;
          for (const pending of pendingByRequest.values()) {
            if (pending.socket === socket) pending.socket = null;
          }
        });
      });
      await new Promise((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
      });
      handlers.log("log", `[KuroHelper] Authenticated API listening on ${host}:${port}.`);
    },

    async stop() {
      if (!server) return;
      for (const socket of server.clients) socket.terminate();
      await new Promise((resolve) => server.close(resolve));
      activeSocket = null;
      server = null;
      pendingByRequest.clear();
      pendingByChat.clear();
      outputByRequest.clear();
      completedByRequest.clear();
    },

    async sendText(chatId, text, metadata = {}) {
      const pending = findPending(chatId, metadata.requestId);
      if (!pending) return;
      if (metadata.kind === "ai_reply") {
        const output = outputByRequest.get(pending.requestId) || [];
        output.push(String(text || ""));
        outputByRequest.set(pending.requestId, output);
        if (!metadata.final) return;
        completeRequest(pending, "generate_response", {
          text: output.join("\n\n"),
          metrics: metadata.metrics || null,
        });
      } else {
        completeRequest(pending, "generate_response", {
          text: String(text || ""),
          metrics: metadata.metrics || null,
        });
      }
    },

    async sendTyping(chatId) {
      const pending = findPending(chatId);
      if (pending) send(pending.socket, "typing", pending.requestId, {});
    },

    async sendImages(chatId, images, caption) {
      const pending = findPending(chatId);
      if (pending) send(pending.socket, "images", pending.requestId, { images, caption });
    },

    async sendMetric(chatId, event = {}) {
      const requestId = String(event.requestId || "").trim();
      if (!requestId) return false;
      return send(activeSocket, "metric_event", requestId, {
        requestId,
        channelId: String(chatId || ""),
        operation: String(event.operation || "background"),
        metrics: event.metrics || null,
      });
    },

    async sendGeneratedImage(chatId, images, caption) {
      return this.sendImages(chatId, images, caption);
    },

    async sendImagePlaceholder(chatId) {
      return this.sendTyping(chatId);
    },

    async sendExpression() {},
    async setActivity() {},
    async streamChunk() {},

    async streamEnd(chatId, payload) {
      const pending = findPending(chatId, payload?.requestId);
      if (!pending || !payload?.finalText) return;
      completeRequest(pending, "generate_response", {
        text: String(payload.finalText),
      });
    },

    async sendRecap(chatId, entries) {
      const pending = findPending(chatId);
      if (!pending) return;
      completeRequest(pending, "generate_response", {
        text: (entries || []).map((entry) => entry?.text || "").filter(Boolean).join("\n\n"),
      });
    },

    async deleteRoleplayMessages() {},
  };
}

module.exports = { createKuroHelperPlugin, PROTOCOL_VERSION };
