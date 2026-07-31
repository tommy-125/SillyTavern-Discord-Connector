"use strict";

const METRICS_PROXY_URL = String(process.env.METRICS_PROXY_URL || "")
  .trim()
  .replace(/\/+$/, "");
const CLAIM_TIMEOUT_MS = 3000;

function sum(records, field) {
  return records.reduce((total, record) => {
    const value = Number(record?.[field]);
    return total + (Number.isFinite(value) && value >= 0 ? value : 0);
  }, 0);
}

function lastValue(records, field, fallback = "") {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const value = records[index]?.[field];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return fallback;
}

function aggregateProviderMetrics(records) {
  const valid = Array.isArray(records) ? records.filter(Boolean) : [];
  if (valid.length === 0) return { generationCount: 0, usageAvailable: false };

  return {
    generationCount: valid.length,
    generationIds: valid.map((record) => String(record.generationId || "")).filter(Boolean),
    model: String(lastValue(valid, "model")),
    provider: String(lastValue(valid, "provider")),
    providers: [...new Set(valid.map((record) => String(record.provider || "")).filter(Boolean))],
    providerModel: String(lastValue(valid, "providerModel")),
    routingStrategy: String(lastValue(valid, "routingStrategy")),
    routingRegion: String(lastValue(valid, "routingRegion")),
    routingAttempt: Number(lastValue(valid, "routingAttempt", 0)) || 0,
    providerStatusCode: Number(lastValue(valid, "statusCode", 0)) || 0,
    usageAvailable: valid.some((record) => record.usageAvailable === true),
    promptTokens: sum(valid, "promptTokens"),
    completionTokens: sum(valid, "completionTokens"),
    totalTokens: sum(valid, "totalTokens"),
    reasoningTokens: sum(valid, "reasoningTokens"),
    cachedTokens: sum(valid, "cachedTokens"),
    costUsd: sum(valid, "costUsd"),
    providerHeadersMs: sum(valid, "headersMs"),
    providerFirstTokenMs: Number(lastValue(valid, "firstTokenMs", 0)) || 0,
    providerDurationMs: sum(valid, "durationMs"),
  };
}

async function claimProviderMetrics(sinceMs) {
  if (!METRICS_PROXY_URL) return aggregateProviderMetrics([]);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CLAIM_TIMEOUT_MS);
  timeout.unref?.();
  try {
    const since = Math.max(0, Number(sinceMs) || 0);
    const response = await fetch(
      `${METRICS_PROXY_URL}/internal/metrics/claim?since=${encodeURIComponent(since)}`,
      { signal: controller.signal },
    );
    if (!response.ok) throw new Error(`metrics proxy returned HTTP ${response.status}`);
    const payload = await response.json();
    return aggregateProviderMetrics(payload.records);
  } catch (error) {
    console.warn(`[Metrics] Provider usage unavailable: ${error.message}`);
    return aggregateProviderMetrics([]);
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { aggregateProviderMetrics, claimProviderMetrics };
