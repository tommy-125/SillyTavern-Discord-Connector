"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildVisionContext,
  createVisionClient,
  isAllowedDiscordImageUrl,
} = require("./vision-client");

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
        choices: [{ message: { content: "圖片 1：一隻黑貓坐在窗邊。" } }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const result = await client.describe([{
    url: "https://cdn.discordapp.com/attachments/1/2/cat.png",
  }], "這是什麼？");

  assert.equal(request.url, "https://openrouter.example/api/v1/chat/completions");
  assert.equal(request.body.model, "google/gemini-2.5-flash-lite");
  assert.equal(request.body.messages[0].content[1].type, "image_url");
  assert.match(result.description, /黑貓/);
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
});
