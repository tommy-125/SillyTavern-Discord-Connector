"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { aggregateProviderMetrics } = require("./metrics-client");

test("aggregateProviderMetrics combines retries and exact usage", () => {
  assert.deepEqual(
    aggregateProviderMetrics([
      {
        generationId: "gen-a",
        model: "model-a",
        provider: "Provider A",
        providerModel: "native-a",
        routingStrategy: "direct",
        routingRegion: "iad",
        routingAttempt: 1,
        statusCode: 200,
        usageAvailable: true,
        promptTokens: 100,
        completionTokens: 20,
        totalTokens: 120,
        reasoningTokens: 3,
        cachedTokens: 10,
        costUsd: 0.001,
        headersMs: 200,
        firstTokenMs: 400,
        durationMs: 800,
      },
      {
        generationId: "gen-b",
        model: "model-a",
        provider: "Provider B",
        providerModel: "native-b",
        routingStrategy: "fallback",
        routingRegion: "fra",
        routingAttempt: 2,
        statusCode: 200,
        usageAvailable: true,
        promptTokens: 110,
        completionTokens: 30,
        totalTokens: 140,
        reasoningTokens: 4,
        cachedTokens: 11,
        costUsd: 0.002,
        headersMs: 250,
        firstTokenMs: 450,
        durationMs: 900,
      },
    ]),
    {
      generationCount: 2,
      generationIds: ["gen-a", "gen-b"],
      model: "model-a",
      provider: "Provider B",
      providers: ["Provider A", "Provider B"],
      providerModel: "native-b",
      routingStrategy: "fallback",
      routingRegion: "fra",
      routingAttempt: 2,
      providerStatusCode: 200,
      usageAvailable: true,
      promptTokens: 210,
      completionTokens: 50,
      totalTokens: 260,
      reasoningTokens: 7,
      cachedTokens: 21,
      costUsd: 0.003,
      providerHeadersMs: 450,
      providerFirstTokenMs: 450,
      providerDurationMs: 1700,
    },
  );
});

test("aggregateProviderMetrics reports unavailable usage when empty", () => {
  assert.deepEqual(aggregateProviderMetrics([]), {
    generationCount: 0,
    usageAvailable: false,
  });
});
