"use strict";

const RAW_RESPONSE_CACHE_LIMIT = 5;
const runtimeRawResponses = new Map();

function normalizeRawResponse(entry) {
  if (!entry || typeof entry !== "object") return null;
  const rawText = String(entry.rawText || "");
  if (!rawText) return null;
  const channelId = String(entry.channelId || "").trim();
  const requestId = String(entry.requestId || "").trim();
  return {
    cachedAt: String(entry.cachedAt || new Date().toISOString()),
    rawText,
    source: String(entry.source || "generation").trim().toLowerCase() || "generation",
    ...(channelId ? { channelId } : {}),
    ...(requestId ? { requestId } : {}),
  };
}

function cacheRuntimeRawResponse(entry, limit = RAW_RESPONSE_CACHE_LIMIT) {
  const normalized = normalizeRawResponse(entry);
  if (!normalized) return false;
  const entries = runtimeRawResponses.get(normalized.channelId || "") || [];
  entries.push(normalized);
  entries.splice(
    0,
    Math.max(0, entries.length - Math.max(1, Number(limit) || 1)),
  );
  runtimeRawResponses.set(normalized.channelId || "", entries);
  return true;
}

function listRuntimeRawResponses(channelId = "") {
  return (runtimeRawResponses.get(String(channelId || "").trim()) || [])
    .map((entry) => ({ ...entry }));
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
  runtimeRawResponses.clear();
}

module.exports = {
  RAW_RESPONSE_CACHE_LIMIT,
  cacheRuntimeRawResponse,
  listRuntimeRawResponses,
  mergeRawResponseEntries,
  resetRuntimeRawResponseCacheForTests,
};
