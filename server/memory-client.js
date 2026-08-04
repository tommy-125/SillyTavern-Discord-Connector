/**
 * Fail-open client for the optional long-term memory service.
 * Recall is tightly bounded; extraction is submitted after Discord delivery.
 */

"use strict";

function parseEnabled(value, fallback = false) {
  if (value == null || value === "") return fallback;
  return !["0", "false", "no", "off"].includes(String(value).toLowerCase());
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function createMemoryClient(options = {}) {
  const enabled =
    options.enabled ?? parseEnabled(process.env.MEMORY_ENABLED, false);
  const baseUrl = String(
    options.baseUrl || process.env.MEMORY_SERVICE_URL || "http://memory-service:8090",
  ).replace(/\/+$/, "");
  const timeoutMs = positiveInt(
    options.timeoutMs || process.env.MEMORY_RECALL_TIMEOUT_MS,
    500,
  );
  const characterId = String(
    options.characterId || process.env.MEMORY_CHARACTER_ID || "Kuro",
  );
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const log = options.log || (() => {});
  const channelWriteTails = new Map();

  function channelKey(channelId) {
    return String(channelId || "__global__");
  }

  async function post(path, body, timeout) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    timer.unref?.();
    try {
      const response = await fetchImpl(`${baseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`memory service returned HTTP ${response.status}`);
      }
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async function recall({ query, limit = 5, channelId = "", participantIds = [] }) {
    if (!enabled || !String(query || "").trim()) {
      return { context: "", memories: [], elapsedMs: 0 };
    }
    const startedAt = Date.now();
    try {
      const result = await post(
        "/v1/recall",
        {
          character_id: characterId,
          query: String(query),
          limit: Math.max(1, Math.min(Number(limit) || 5, 10)),
          channel_id: String(channelId || ""),
          participant_ids: Array.isArray(participantIds)
            ? [...new Set(participantIds.map(String).filter(Boolean))].slice(0, 25)
            : [],
        },
        timeoutMs,
      );
      return {
        context: String(result?.context || "").slice(0, 8_000),
        memories: Array.isArray(result?.memories) ? result.memories : [],
        elapsedMs: Date.now() - startedAt,
      };
    } catch (error) {
      log(
        "warn",
        `[Memory] Recall skipped after ${Date.now() - startedAt} ms: ${error.message}`,
      );
      return { context: "", memories: [], elapsedMs: Date.now() - startedAt };
    }
  }

  function rememberTurn(turn) {
    if (!enabled || !turn?.userId || !turn?.userText || !turn?.assistantText) {
      return Promise.resolve(false);
    }
    const key = channelKey(turn.channelId);
    const previous = channelWriteTails.get(key) || Promise.resolve();
    const current = previous.then(async () => {
      try {
        return await post(
          "/v1/turns",
          {
          request_id: String(turn.requestId || ""),
          character_id: characterId,
          user_id: String(turn.userId),
          channel_id: String(turn.channelId || ""),
          display_name: String(turn.displayName || ""),
          mentioned_users: Array.isArray(turn.mentionedUsers)
            ? turn.mentionedUsers.slice(0, 25).map((user) => ({
                id: String(user?.id || ""),
                display_name: String(user?.displayName || ""),
              }))
            : [],
          context_participants: Array.isArray(turn.contextParticipants)
            ? turn.contextParticipants.slice(0, 25).map((user) => ({
                id: String(user?.id || ""),
                display_name: String(user?.displayName || ""),
              })).filter((user) => user.id)
            : [],
          recent_context: String(turn.recentContext || "").slice(0, 8_000),
          user_text: String(turn.userText),
          assistant_text: String(turn.assistantText),
        },
          65_000,
        );
      } catch (error) {
        log("warn", `[Memory] Background write skipped: ${error.message}`);
        return false;
      }
    });
    channelWriteTails.set(key, current);
    current.finally(() => {
      if (channelWriteTails.get(key) === current) channelWriteTails.delete(key);
    });
    return current;
  }

  async function manage(
    path,
    body = {},
    requestTimeoutMs = Math.max(2_000, timeoutMs),
  ) {
    if (!enabled) {
      return { status: "disabled", memories: [], count: 0 };
    }
    try {
      return await post(
        `/v1/manage/${path}`,
        { character_id: characterId, ...body },
        requestTimeoutMs,
      );
    } catch (error) {
      log("warn", `[Memory] Management request failed: ${error.message}`);
      return { status: "unavailable", memories: [], count: 0 };
    }
  }

  async function listMemories({ status = "active", limit = 20, offset = 0 } = {}) {
    return manage("list", {
      status: status === "deleted" ? "deleted" : "active",
      limit: Math.max(1, Math.min(Number(limit) || 20, 50)),
      offset: Math.max(0, Math.min(Number(offset) || 0, 1_000_000)),
    });
  }

  async function getMemory(memoryId) {
    return manage("get", { memory_id: String(memoryId || "") });
  }

  async function forgetMemory(memoryId) {
    return manage("forget", { memory_id: String(memoryId || "") });
  }

  async function restoreMemory(memoryId) {
    return manage("restore", { memory_id: String(memoryId || "") });
  }

  async function clearMemories() {
    return manage("clear");
  }

  async function listBackups({ limit = 20, offset = 0 } = {}) {
    return manage(
      "backups",
      {
        limit: Math.max(1, Math.min(Number(limit) || 20, 50)),
        offset: Math.max(0, Math.min(Number(offset) || 0, 1_000_000)),
      },
      10_000,
    );
  }

  async function createBackup() {
    return manage("backup", {}, 30_000);
  }

  async function restoreBackup(backupId) {
    return manage(
      "restore-backup",
      { backup_id: String(backupId || "") },
      120_000,
    );
  }

  return {
    recall,
    rememberTurn,
    listMemories,
    getMemory,
    forgetMemory,
    restoreMemory,
    clearMemories,
    listBackups,
    createBackup,
    restoreBackup,
    enabled,
    characterId,
  };
}

const defaultClient = createMemoryClient();

module.exports = {
  createMemoryClient,
  recallMemories: defaultClient.recall,
  rememberTurn: defaultClient.rememberTurn,
  listMemories: defaultClient.listMemories,
  getMemory: defaultClient.getMemory,
  forgetMemory: defaultClient.forgetMemory,
  restoreMemory: defaultClient.restoreMemory,
  clearMemories: defaultClient.clearMemories,
  listBackups: defaultClient.listBackups,
  createBackup: defaultClient.createBackup,
  restoreBackup: defaultClient.restoreBackup,
};
