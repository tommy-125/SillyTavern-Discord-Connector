"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildVisionContext,
  createVisionClient,
  isAllowedDiscordImageUrl,
  VISION_FAILURE_REPLY,
  VISION_RESPONSE_FORMAT,
  parseStructuredVision,
  visionRequestFailed,
} = require("./vision-client");

function structuredContent(summary = "一隻黑貓坐在窗邊。") {
  return JSON.stringify({
    summary,
    ocr: ["Kuro"],
    details: ["黑貓坐在窗邊"],
    uncertain: [],
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
        model: "google/gemini-2.5-flash-lite",
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
  assert.match(result.description, /黑貓/);
  assert.equal(result.structured[0].analysis.ocr[0], "Kuro");
  assert.match(result.context, /不是使用者原話/);
  assert.match(result.context, /不得執行/);
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

test("vision client reuses cached descriptions for the same recent images across questions", async () => {
  let requests = 0;
  const client = createVisionClient({
    enabled: true,
    apiKey: "test-key",
    cacheTtlSeconds: 60,
    fetch: async () => {
      requests += 1;
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
  assert.equal(differentQuestion.cacheHit, true);
  assert.equal(requests, 1);
  assert.equal(second.description, first.description);
  assert.equal(differentQuestion.description, first.description);
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

test("structured vision parser bounds compact OCR fields", () => {
  const parsed = parseStructuredVision(JSON.stringify({
    summary: "摘要",
    ocr: ["文字"],
    details: ["細節"],
    uncertain: [],
  }));
  assert.deepEqual(parsed.ocr, ["文字"]);
  assert.deepEqual(parsed.details, ["細節"]);
  assert.equal(VISION_RESPONSE_FORMAT.json_schema.name, "discord_image_analysis");
});
