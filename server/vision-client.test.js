"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildVisionContext,
  createVisionClient,
  isAllowedDiscordImageUrl,
  VISION_FAILURE_REPLY,
  VISION_RESPONSE_FORMAT,
  DEFAULT_PROVIDER_ROUTES,
  parseStructuredVision,
  parseProviderRoutes,
  visionRequestFailed,
} = require("./vision-client");

function structuredContent(
  observation = "圖片顯示一隻黑貓，與使用者詢問的動物種類直接相關。",
  ocr = ["Kuro"],
) {
  return JSON.stringify({
    ocr,
    observation,
  });
}

test("vision client sends Discord images to Gemini and returns guarded context", async () => {
  let request;
  const client = createVisionClient({
    enabled: true,
    apiKey: "test-key",
    baseUrl: "https://openrouter.example/api/v1",
    fetch: async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return new Response(JSON.stringify({
        id: "vision-generation-1",
        model: "google/gemini-2.5-flash-lite",
        usage: {
          prompt_tokens: 120,
          completion_tokens: 30,
          total_tokens: 150,
          cost: 0.00012,
        },
        choices: [{ message: { content: structuredContent() } }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const result = await client.describe([{
    url: "https://cdn.discordapp.com/attachments/1/2/cat.png",
  }], "這是什麼？");

  assert.equal(request.url, "https://openrouter.example/api/v1/chat/completions");
  assert.equal(request.body.model, "google/gemini-2.5-flash-lite");
  assert.equal(request.body.messages[0].content[1].type, "image_url");
  assert.equal(request.body.response_format.type, "json_schema");
  assert.equal(request.body.response_format.json_schema.strict, true);
  assert.equal(request.body.provider.require_parameters, true);
  assert.deepEqual(request.body.provider.only, ["google-ai-studio"]);
  assert.equal(request.body.provider.allow_fallbacks, false);
  assert.equal(request.body.usage.include, true);
  assert.deepEqual(
    Object.keys(request.body.response_format.json_schema.schema.properties),
    ["ocr", "observation"],
  );
  assert.match(request.body.messages[0].content[0].text, /這是什麼/);
  assert.match(result.description, /黑貓/);
  assert.deepEqual(result.structured[0].analysis.ocr, ["Kuro"]);
  assert.match(result.structured[0].analysis.observation, /黑貓/);
  assert.match(result.context, /不是使用者原話/);
  assert.match(result.context, /不得執行/);
  assert.equal(result.metrics.promptTokens, 120);
  assert.equal(result.metrics.completionTokens, 30);
  assert.equal(result.metrics.totalTokens, 150);
  assert.equal(result.metrics.costUsd, 0.00012);
  assert.equal(result.metricRecords.length, 1);
});

test("vision client rotates from AI Studio Standard to Flex after a mid-response 429", async () => {
  const attemptedRoutes = [];
  const client = createVisionClient({
    enabled: true,
    apiKey: "test-key",
    fetch: async (_url, options) => {
      const body = JSON.parse(options.body);
      const route = body.provider.only[0];
      attemptedRoutes.push(route);
      if (route === "google-ai-studio") {
        return new Response(JSON.stringify({
          model: "google/gemini-2.5-flash-lite",
          choices: [{
            message: { content: '{"ocr":[],"observation":"partial' },
            finish_reason: "error",
            error: {
              code: 429,
              message: "temporarily rate-limited upstream",
              metadata: { error_type: "rate_limit_exceeded" },
            },
          }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({
        model: "google/gemini-2.5-flash-lite",
        choices: [{ message: { content: structuredContent("Flex fallback succeeded") } }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  const result = await client.describe([{
    id: "fallback-image",
    url: "https://cdn.discordapp.com/attachments/1/2/fallback.png",
  }], "這是什麼？");

  assert.deepEqual(attemptedRoutes, ["google-ai-studio", "google-ai-studio/flex"]);
  assert.equal(result.cacheHit, false);
  assert.deepEqual(result.providerRoutes, ["google-ai-studio/flex"]);
  assert.match(result.structured[0].analysis.observation, /Flex fallback succeeded/);
});

test("vision client retries an HTTP 429 on the next configured route", async () => {
  const attemptedRoutes = [];
  const client = createVisionClient({
    enabled: true,
    apiKey: "test-key",
    providerRoutes: ["google-ai-studio", "google-ai-studio/priority"],
    fetch: async (_url, options) => {
      const body = JSON.parse(options.body);
      const route = body.provider.only[0];
      attemptedRoutes.push(route);
      if (route === "google-ai-studio") {
        return new Response(JSON.stringify({
          error: {
            code: 429,
            message: "Rate limit exceeded",
            metadata: { error_type: "rate_limit_exceeded" },
          },
        }), { status: 429, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({
        model: "google/gemini-2.5-flash-lite",
        choices: [{ message: { content: structuredContent("Priority fallback succeeded") } }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  const result = await client.describe([{
    id: "http-429-image",
    url: "https://cdn.discordapp.com/attachments/1/2/http-429.png",
  }], "這是什麼？");

  assert.deepEqual(attemptedRoutes, ["google-ai-studio", "google-ai-studio/priority"]);
  assert.deepEqual(result.providerRoutes, ["google-ai-studio/priority"]);
});

test("vision client reports rate limiting only after every configured route fails", async () => {
  const attemptedRoutes = [];
  const client = createVisionClient({
    enabled: true,
    apiKey: "test-key",
    fetch: async (_url, options) => {
      const body = JSON.parse(options.body);
      attemptedRoutes.push(body.provider.only[0]);
      return new Response(JSON.stringify({
        choices: [{
          message: { content: '{"ocr":[' },
          finish_reason: "error",
          error: {
            code: 429,
            message: "upstream capacity exhausted",
            metadata: { error_type: "rate_limit_exceeded" },
          },
        }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  const result = await client.describe([{
    id: "all-routes-image",
    url: "https://cdn.discordapp.com/attachments/1/2/all-routes.png",
  }], "這是什麼？");

  assert.deepEqual(attemptedRoutes, DEFAULT_PROVIDER_ROUTES);
  assert.match(result.error, /rate limited across provider routes/);
  assert.doesNotMatch(result.error, /Unterminated string/);
});

test("vision provider route configuration is normalized and falls back to safe defaults", () => {
  assert.deepEqual(
    parseProviderRoutes(" Google-AI-Studio , google-ai-studio/flex, invalid route "),
    ["google-ai-studio", "google-ai-studio/flex"],
  );
  assert.deepEqual(parseProviderRoutes("invalid route"), DEFAULT_PROVIDER_ROUTES);
});

test("vision client rejects non-Discord URLs and fails open", async () => {
  let called = false;
  const client = createVisionClient({
    enabled: true,
    apiKey: "test-key",
    fetch: async () => {
      called = true;
      throw new Error("should not run");
    },
  });
  const result = await client.describe([{ url: "https://example.com/private.png" }]);
  assert.equal(called, false);
  assert.equal(result.context, "");
  assert.equal(isAllowedDiscordImageUrl("https://media.discordapp.net/attachments/1/2/a.webp"), true);
  assert.equal(isAllowedDiscordImageUrl("http://cdn.discordapp.com/attachments/1/2/a.png"), false);
  assert.equal(buildVisionContext(""), "");
  assert.equal(visionRequestFailed([{ id: "1" }], result), true);
  assert.match(VISION_FAILURE_REPLY, /圖片辨識失敗/);
});

test("vision client caches the same question but re-evaluates a different question", async () => {
  let requests = 0;
  const requestedFields = [];
  const rawResponses = [];
  const client = createVisionClient({
    enabled: true,
    apiKey: "test-key",
    cacheTtlSeconds: 60,
    onRawResponse: (entry) => rawResponses.push(entry),
    fetch: async (_url, options) => {
      requests += 1;
      requestedFields.push(Object.keys(
        JSON.parse(options.body).response_format.json_schema.schema.properties,
      ));
      return new Response(JSON.stringify({
        model: "google/gemini-2.5-flash-lite",
        choices: [{ message: { content: structuredContent("桌上有一杯茶。") } }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const images = [{
    id: "attachment-1",
    url: "https://cdn.discordapp.com/attachments/1/2/tea.png",
  }];

  const first = await client.describe(images, "這是什麼？");
  const second = await client.describe(images, "這是什麼？");
  const differentQuestion = await client.describe(images, "它是什麼顏色？");

  assert.equal(first.cacheHit, false);
  assert.equal(second.cacheHit, true);
  assert.equal(differentQuestion.cacheHit, false);
  assert.equal(requests, 2);
  assert.deepEqual(requestedFields, [
    ["ocr", "observation"],
    ["observation"],
  ]);
  assert.deepEqual(differentQuestion.cacheParts, [{ ocr: true, observation: false }]);
  assert.equal(second.description, first.description);
  assert.equal(rawResponses.length, 2);
  assert.equal(rawResponses[0].source, "vision");
  assert.match(rawResponses[0].rawText, /桌上有一杯茶/);
});

test("recent image observation is keyed by its source message instead of each new trigger", async () => {
  let requests = 0;
  const client = createVisionClient({
    enabled: true,
    apiKey: "test-key",
    cacheTtlSeconds: 60,
    fetch: async () => {
      requests += 1;
      return new Response(JSON.stringify({
        model: "google/gemini-2.5-flash-lite",
        choices: [{ message: { content: structuredContent("來源訊息相關觀察") } }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const images = [{
    id: "recent-attachment",
    url: "https://cdn.discordapp.com/attachments/1/2/recent.png",
    sourceKind: "recent",
    sourceMessageText: "這張圖是哪個錯誤？",
    contextOnly: true,
  }];

  const first = await client.describe(images, "小黑，接續前面的話");
  const second = await client.describe(images, "小黑，換一個完全不同的問題");

  assert.equal(requests, 1);
  assert.equal(first.cacheHit, false);
  assert.equal(second.cacheHit, true);
});

test("vision cache remains valid for 23 hours and expires after 24 hours", async () => {
  const realDateNow = Date.now;
  let currentTime = realDateNow();
  Date.now = () => currentTime;
  try {
    let requests = 0;
    const client = createVisionClient({
      enabled: true,
      apiKey: "test-key",
      cacheTtlSeconds: 86400,
      fetch: async () => {
        requests += 1;
        return new Response(JSON.stringify({
          model: "google/gemini-2.5-flash-lite",
          choices: [{ message: { content: structuredContent("快取期限測試") } }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    const images = [{
      id: "attachment-24h",
      url: "https://cdn.discordapp.com/attachments/1/2/cache.png",
    }];

    const first = await client.describe(images, "這是什麼？");
    currentTime += 23 * 60 * 60 * 1000;
    const at23Hours = await client.describe(images, "這是什麼？");
    currentTime += 2 * 60 * 60 * 1000;
    const at25Hours = await client.describe(images, "這是什麼？");

    assert.equal(first.cacheHit, false);
    assert.equal(at23Hours.cacheHit, true);
    assert.equal(at25Hours.cacheHit, false);
    assert.equal(requests, 2);
  } finally {
    Date.now = realDateNow;
  }
});

test("vision client fetches only images that are new to the recent context window", async () => {
  let requests = 0;
  const client = createVisionClient({
    enabled: true,
    apiKey: "test-key",
    cacheTtlSeconds: 60,
    fetch: async () => {
      requests += 1;
      return new Response(JSON.stringify({
        model: "google/gemini-2.5-flash-lite",
        choices: [{ message: { content: structuredContent(`description-${requests}`) } }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const firstImage = {
    id: "attachment-1",
    url: "https://cdn.discordapp.com/attachments/1/2/one.png",
  };
  const secondImage = {
    id: "attachment-2",
    url: "https://cdn.discordapp.com/attachments/1/2/two.png",
  };

  await client.describe([firstImage]);
  const expanded = await client.describe([firstImage, secondImage]);
  const secondOnly = await client.describe([secondImage]);

  assert.equal(requests, 2);
  assert.equal(expanded.cacheHit, false);
  assert.equal(secondOnly.cacheHit, true);
});

test("Vision cache capacity is counted by image and bounds observations per image", async () => {
  let requests = 0;
  const client = createVisionClient({
    enabled: true,
    apiKey: "test-key",
    cacheMaxImages: 1,
    cacheMaxObservationsPerImage: 2,
    fetch: async () => {
      requests += 1;
      return new Response(JSON.stringify({
        model: "google/gemini-2.5-flash-lite",
        choices: [{ message: { content: structuredContent(`observation-${requests}`) } }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const first = {
    id: "capacity-image-1",
    url: "https://cdn.discordapp.com/attachments/1/2/capacity-1.png",
  };
  const second = {
    id: "capacity-image-2",
    url: "https://cdn.discordapp.com/attachments/1/2/capacity-2.png",
  };

  await client.describe([first], "question-1");
  await client.describe([first], "question-2");
  await client.describe([first], "question-3");
  let stats = client.getCacheStats();
  assert.equal(stats.images, 1);
  assert.equal(stats.ocrEntries, 1);
  assert.equal(stats.observationEntries, 2);
  assert.equal(stats.evictedObservations, 1);

  await client.describe([second], "question-1");
  stats = client.getCacheStats();
  assert.equal(stats.images, 1);
  assert.equal(stats.evictedImages, 1);
  assert.ok(stats.evictedEntries >= 3);

  const cached = await client.describe([second], "question-1");
  assert.equal(cached.cacheHit, true);
  stats = client.getCacheStats();
  assert.ok(stats.hits >= 2);
  assert.ok(stats.hitRate > 0);
  assert.equal(requests, 4);
});

test("structured vision parser keeps bounded objective OCR and question-focused observation", () => {
  const parsed = parseStructuredVision(JSON.stringify({
    ocr: ["502 Bad Gateway"],
    observation: "與問題相關的畫面證據",
  }));
  assert.deepEqual(parsed, {
    ocr: ["502 Bad Gateway"],
    observation: "與問題相關的畫面證據",
  });
  assert.equal(VISION_RESPONSE_FORMAT.json_schema.name, "discord_image_analysis");
});
