"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  cacheRuntimeRawResponse,
  listRuntimeRawResponses,
  mergeRawResponseEntries,
  resetRuntimeRawResponseCacheForTests,
} = require("./raw-response-cache");

test.beforeEach(() => resetRuntimeRawResponseCacheForTests());

test("runtime raw-response cache preserves only the newest five Vision replies", () => {
  for (let index = 0; index < 7; index += 1) {
    cacheRuntimeRawResponse({
      cachedAt: `2026-08-04T00:00:0${index}.000Z`,
      rawText: `{"observation":"vision-${index}"}`,
      source: "vision",
    });
  }
  assert.deepEqual(
    listRuntimeRawResponses().map((entry) => entry.rawText),
    [
      '{"observation":"vision-2"}',
      '{"observation":"vision-3"}',
      '{"observation":"vision-4"}',
      '{"observation":"vision-5"}',
      '{"observation":"vision-6"}',
    ],
  );
});

test("Vision and main-model raw replies share one chronological five-entry view", () => {
  const merged = mergeRawResponseEntries([
    [{ cachedAt: "2026-08-04T00:00:01.000Z", rawText: "main-1", source: "generation" }],
    [
      { cachedAt: "2026-08-04T00:00:02.000Z", rawText: "vision-1", source: "vision" },
      { cachedAt: "2026-08-04T00:00:03.000Z", rawText: "vision-2", source: "vision" },
    ],
  ], 2);
  assert.deepEqual(merged, [
    { cachedAt: "2026-08-04T00:00:02.000Z", rawText: "vision-1", source: "vision" },
    { cachedAt: "2026-08-04T00:00:03.000Z", rawText: "vision-2", source: "vision" },
  ]);
});

test("runtime raw-response cache isolates Discord channels", () => {
  cacheRuntimeRawResponse({ rawText: "channel-a", channelId: "kurohelper:a" });
  cacheRuntimeRawResponse({ rawText: "channel-b", channelId: "kurohelper:b" });
  assert.deepEqual(listRuntimeRawResponses("kurohelper:a").map((entry) => entry.rawText), ["channel-a"]);
  assert.deepEqual(listRuntimeRawResponses("kurohelper:b").map((entry) => entry.rawText), ["channel-b"]);
});
