"use strict";

const RAW_RESPONSE_CACHE_LIMIT = 5;
const runtimeRawResponses = [];

function normalizeRawResponse(entry) {
  if (!entry || typeof entry !== "object") return null;
  const rawText = String(entry.rawText || "");
  if (!rawText) return null;
  return {
    cachedAt: String(entry.cachedAt || new Date().toISOString()),
    rawText,
    source: String(entry.source || "generation").trim().toLowerCase() || "generation",
  };
}

function cacheRuntimeRawResponse(entry, limit = RAW_RESPONSE_CACHE_LIMIT) {
  const normalized = normalizeRawResponse(entry);
  if (!normalized) return false;
  runtimeRawResponses.push(normalized);
  runtimeRawResponses.splice(
    0,
    Math.max(0, runtimeRawResponses.length - Math.max(1, Number(limit) || 1)),
  );
  return true;
}

function listRuntimeRawResponses() {
  return runtimeRawResponses.map((entry) => ({ ...entry }));
}

function mergeRawResponseEntries(entryGroups, limit = RAW_RESPONSE_CACHE_LIMIT) {
  const unique = new Map();
  for (const entry of (Array.isArray(entryGroups) ? entryGroups : []).flat()) {
    const normalized = normalizeRawResponse(entry);
    if (!normalized) continue;
    const key = `${normalized.cachedAt}\0${normalized.source}\0${normalized.rawText}`;
    unique.set(key, normalized);
  }
  return [...unique.values()]
    .sort((left, right) => left.cachedAt.localeCompare(right.cachedAt))
    .slice(-Math.max(1, Number(limit) || 1));
}

function resetRuntimeRawResponseCacheForTests() {
  runtimeRawResponses.length = 0;
}

module.exports = {
  RAW_RESPONSE_CACHE_LIMIT,
  cacheRuntimeRawResponse,
  listRuntimeRawResponses,
  mergeRawResponseEntries,
  resetRuntimeRawResponseCacheForTests,
};
