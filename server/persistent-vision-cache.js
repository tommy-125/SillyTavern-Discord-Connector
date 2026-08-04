"use strict";

const fs = require("node:fs");
const path = require("node:path");

const VISION_CACHE_FILE_VERSION = 1;

function defaultVisionCachePath() {
  const configuredPath = String(process.env.VISION_CACHE_PATH || "").trim();
  if (configuredPath) return configuredPath;
  const dataDir = String(
    process.env.CONNECTOR_DATA_DIR || path.join(__dirname, "..", "runtime"),
  ).trim();
  return path.join(dataDir, "vision-cache.json");
}

function createPersistentVisionCache(options = {}) {
  const filePath = String(options.filePath || defaultVisionCachePath());
  const now = typeof options.now === "function" ? options.now : Date.now;
  const logger = options.logger || console;
  const cache = new Map();
  let loadedEntries = 0;

  try {
    const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (payload?.version === VISION_CACHE_FILE_VERSION && Array.isArray(payload.entries)) {
      for (const item of payload.entries) {
        if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== "string") continue;
        const entry = item[1];
        if (!entry || typeof entry !== "object" || Number(entry.expiresAt) <= now()) continue;
        cache.set(item[0], entry);
      }
      loadedEntries = cache.size;
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      logger.warn?.(`[Vision Cache] Could not load ${filePath}: ${error.message}`);
    }
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const temporaryPath = `${filePath}.tmp`;
      fs.writeFileSync(temporaryPath, JSON.stringify({
        version: VISION_CACHE_FILE_VERSION,
        savedAt: new Date(now()).toISOString(),
        entries: [...cache.entries()],
      }), { encoding: "utf8", mode: 0o600 });
      fs.renameSync(temporaryPath, filePath);
      return true;
    } catch (error) {
      logger.warn?.(`[Vision Cache] Could not save ${filePath}: ${error.message}`);
      return false;
    }
  }

  return {
    cache,
    filePath,
    loadedEntries,
    persistent: true,
    save,
  };
}

module.exports = {
  VISION_CACHE_FILE_VERSION,
  createPersistentVisionCache,
  defaultVisionCachePath,
};
