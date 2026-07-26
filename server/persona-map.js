/**
 * persona-map.js - SillyTavern Discord Connector: User Persona Map
 * Copyright (c) 2026 Senjin the Dragon.
 * https://github.com/senjinthedragon/SillyTavern-Discord-Connector
 * Licensed under the MIT License.
 * See /server/LICENSE for full license information.
 *
 * Manages the mapping from platform user IDs to SillyTavern persona names.
 * Two sources are merged at runtime:
 *
 *   1. config.<platform>PersonaMap - static owner-configured maps in config.js
 *      (e.g. discordPersonaMap, telegramPersonaMap, signalPersonaMap).
 *      Useful for assigning personas that users cannot change themselves.
 *   2. server/persona-map.json  - runtime file updated by /mypersona commands.
 *      User-saved preferences take priority over the owner config.
 *
 * The JSON file is written atomically on every save so a crash mid-write
 * cannot corrupt it.
 *
 * createPersonaMapStore(options) is exported for use in tests, allowing
 * injection of a custom file path and config object.
 */

"use strict";

const path = require("path");
const fs = require("fs");

const DEFAULT_DATA_DIR = process.env.CONNECTOR_DATA_DIR
  ? path.resolve(process.env.CONNECTOR_DATA_DIR)
  : __dirname;
const DEFAULT_MAP_FILE = path.join(DEFAULT_DATA_DIR, "persona-map.json");

function normalizePersonaDisplayName(displayName, userId) {
  const cleaned = String(displayName || "")
    .replace(/[\u0000-\u001f\u007f|\\"]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 64);
  const suffix = String(userId || "").slice(-6) || "unknown";
  return cleaned || `Discord User ${suffix}`;
}

function createPersonaMapStore(options = {}) {
  const filePath = options.filePath || DEFAULT_MAP_FILE;
  const getConfig =
    options.getConfig || (() => require("./config-loader").config);
  const getLog = options.getLog || (() => require("./logger").log);

  let runtimeMap = {};

  function load() {
    const log = getLog();
    let fileCount = 0;
    try {
      runtimeMap = JSON.parse(fs.readFileSync(filePath, "utf8"));
      fileCount = Object.values(runtimeMap).reduce(
        (n, m) => n + Object.keys(m).length,
        0,
      );
    } catch (err) {
      runtimeMap = {};
      if (err.code !== "ENOENT") {
        // ENOENT is expected on first run - no file yet, nothing to warn about.
        log(
          "warn",
          `[PersonaMap] Could not read persona-map.json: ${err.message}`,
        );
      }
    }

    const cfg = getConfig();
    const configCount = ["discord", "telegram", "signal"].reduce(
      (n, p) => n + Object.keys(cfg[p + "PersonaMap"] || {}).length,
      0,
    );
    const total = fileCount + configCount;
    log(
      "log",
      `[PersonaMap] ${total} persona mapping${total !== 1 ? "s" : ""} loaded` +
        (total > 0
          ? ` (${fileCount} user-saved, ${configCount} from config.js)`
          : " - none configured yet"),
    );
  }

  /**
   * Returns the persona name mapped to the given user, or null if none.
   * Runtime (user-saved) entries take priority over the owner config.
   *
   * @param {string} platform  e.g. "discord"
   * @param {string} userId    platform-native user ID
   * @returns {string|null}
   */
  function getPersonaForUser(platform, userId) {
    if (!userId) return null;

    const platformMap = runtimeMap[platform];
    if (
      platformMap &&
      Object.prototype.hasOwnProperty.call(platformMap, userId)
    ) {
      return platformMap[userId] || null;
    }

    const cfg = getConfig();
    return cfg[platform + "PersonaMap"]?.[userId] ?? null;
  }

  function findUserForPersona(platform, personaName) {
    if (!personaName) return null;

    const target = String(personaName).toLocaleLowerCase();
    const cfg = getConfig();
    const merged = {
      ...(cfg[platform + "PersonaMap"] || {}),
      ...(runtimeMap[platform] || {}),
    };

    for (const [mappedUserId, mappedPersona] of Object.entries(merged)) {
      if (
        typeof mappedPersona === "string" &&
        mappedPersona.toLocaleLowerCase() === target
      ) {
        return mappedUserId;
      }
    }

    return null;
  }

  /**
   * Creates and persists a mapping for a previously unseen platform user.
   * Display-name collisions receive a stable Discord-ID suffix.
   *
   * @returns {{personaName: string, mappingCreated: boolean}}
   */
  function ensurePersonaForUser(platform, userId, displayName) {
    const existing = getPersonaForUser(platform, userId);
    if (existing) {
      return { personaName: existing, mappingCreated: false };
    }

    const baseName = normalizePersonaDisplayName(displayName, userId);
    let personaName = baseName;
    const currentOwner = findUserForPersona(platform, personaName);

    if (currentOwner && currentOwner !== userId) {
      const suffix = String(userId).slice(-6);
      personaName = `${baseName.slice(0, Math.max(1, 55 - suffix.length))} (${suffix})`;
    }

    setPersonaForUser(platform, userId, personaName);
    return { personaName, mappingCreated: true };
  }

  /**
   * Saves or removes a user-persona mapping and writes the updated map to disk.
   *
   * @param {string}      platform     e.g. "discord"
   * @param {string}      userId       platform-native user ID
   * @param {string|null} personaName  persona name to save, or null to remove
   */
  function setPersonaForUser(platform, userId, personaName) {
    const log = getLog();
    if (!userId) return;

    if (!runtimeMap[platform]) runtimeMap[platform] = {};

    if (personaName === null || personaName === undefined) {
      delete runtimeMap[platform][userId];
      if (Object.keys(runtimeMap[platform]).length === 0) {
        delete runtimeMap[platform];
      }
    } else {
      runtimeMap[platform][userId] = personaName;
    }

    try {
      const tmp = filePath + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(runtimeMap, null, 2), "utf8");
      fs.renameSync(tmp, filePath);
    } catch (err) {
      log("error", `[PersonaMap] Failed to save persona map: ${err.message}`);
    }
  }

  return {
    load,
    getPersonaForUser,
    ensurePersonaForUser,
    setPersonaForUser,
  };
}

// Default singleton used by the rest of the application.
const defaultStore = createPersonaMapStore();

// The active ST persona name sent by the extension on connect. Used as the
// cross-relay sender label when no per-user mapping is configured.
let _defaultPersonaName = null;

// Whether the extension has cross-platform relay enabled. Defaults to true so
// relay works before the first client_info packet arrives.
let _crossPlatformRelay = true;

module.exports = {
  load: () => defaultStore.load(),
  getPersonaForUser: (p, u) => defaultStore.getPersonaForUser(p, u),
  ensurePersonaForUser: (p, u, n) =>
    defaultStore.ensurePersonaForUser(p, u, n),
  setPersonaForUser: (p, u, n) => defaultStore.setPersonaForUser(p, u, n),
  setDefaultPersonaName: (name) => {
    _defaultPersonaName = name || null;
  },
  getDefaultPersonaName: () => _defaultPersonaName,
  setCrossRelayEnabled: (val) => {
    _crossPlatformRelay = val !== false;
  },
  isCrossRelayEnabled: () => _crossPlatformRelay,
  normalizePersonaDisplayName,
  createPersonaMapStore,
};
