"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  applyGenerationOverrides,
  buildUpstreamUrl,
  parseSseEvents,
  routingFromPayload,
  usageFromPayload,
} = require("./server");

test("applyGenerationOverrides forces reasoning off and requests usage", () => {
  assert.deepEqual(
    applyGenerationOverrides(
      {
        usage: { include: false },
        reasoning_effort: "high",
        include_reasoning: true,
      },
      { forceReasoningEffort: "none", providerSort: "latency" },
    ),
    {
      usage: { include: true },
      provider: { sort: "latency" },
      reasoning: { enabled: false, exclude: true },
    },
  );
});

test("applyGenerationOverrides preserves model-default reasoning", () => {
  assert.deepEqual(
    applyGenerationOverrides(
      { reasoning: { effort: "auto" } },
      { forceReasoningEffort: "", providerSort: "latency" },
    ),
    {
      usage: { include: true },
      provider: { sort: "latency" },
      reasoning: { effort: "auto" },
    },
  );
});

test("buildUpstreamUrl preserves the OpenAI-compatible path and query", () => {
  assert.equal(
    buildUpstreamUrl("/v1/models?input_modalities=text"),
    "https://openrouter.ai/api/v1/models?input_modalities=text",
  );
});

test("parseSseEvents handles a usage-only final event", () => {
  const payloads = [];
  const state = { buffer: "" };
  parseSseEvents(
    state,
    'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: {"usage":{"prompt_tokens":10,"completion_tokens":2,"cost":0.01}}\n\n',
    (payload) => payloads.push(payload),
  );
  assert.equal(payloads.length, 2);
  assert.equal(payloads[0].choices[0].delta.content, "hi");
  assert.equal(usageFromPayload(payloads[1]).costUsd, 0.01);
});

test("usageFromPayload extracts reasoning and cache details", () => {
  assert.deepEqual(
    usageFromPayload({
      usage: {
        prompt_tokens: 100,
        completion_tokens: 30,
        total_tokens: 130,
        cost: 0.002,
        prompt_tokens_details: { cached_tokens: 25 },
        completion_tokens_details: { reasoning_tokens: 7 },
      },
    }),
    {
      promptTokens: 100,
      completionTokens: 30,
      totalTokens: 130,
      reasoningTokens: 7,
      cachedTokens: 25,
      costUsd: 0.002,
    },
  );
});

test("routingFromPayload extracts the selected OpenRouter provider", () => {
  assert.deepEqual(
    routingFromPayload({
      openrouter_metadata: {
        strategy: "direct",
        region: "iad",
        attempt: 2,
        endpoints: {
          available: [
            { provider: "Provider A", model: "model-a", selected: false },
            { provider: "Provider B", model: "model-b", selected: true },
          ],
        },
        attempts: [
          { provider: "Provider A", model: "model-a", status: 502 },
          { provider: "Provider B", model: "model-b", status: 200 },
        ],
      },
    }),
    {
      provider: "Provider B",
      providerModel: "model-b",
      routingStrategy: "direct",
      routingRegion: "iad",
      routingAttempt: 2,
    },
  );
});

test("routingFromPayload falls back to the legacy provider field", () => {
  assert.equal(routingFromPayload({ provider: "Legacy Provider" }).provider, "Legacy Provider");
});
