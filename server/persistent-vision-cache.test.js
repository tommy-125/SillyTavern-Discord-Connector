"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createPersistentVisionCache } = require("./persistent-vision-cache");
const { createVisionClient } = require("./vision-client");

test("Vision cache survives a new store instance and drops expired entries", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kuro-vision-cache-"));
  const filePath = path.join(directory, "cache.json");
  try {
    const first = createPersistentVisionCache({ filePath, now: () => 1000 });
    first.cache.set("valid", { expiresAt: 5000, value: { ocr: ["Kuro"] } });
    first.cache.set("expired", { expiresAt: 999, value: { ocr: ["old"] } });
    assert.equal(first.save(), true);

    const second = createPersistentVisionCache({ filePath, now: () => 2000 });
    assert.deepEqual(second.cache.get("valid").value.ocr, ["Kuro"]);
    assert.equal(second.cache.has("expired"), false);
    assert.equal(second.loadedEntries, 1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("Vision client reuses persisted OCR and observation after recreation", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kuro-vision-client-cache-"));
  const filePath = path.join(directory, "cache.json");
  let requests = 0;
  const image = {
    id: "persistent-image",
    url: "https://cdn.discordapp.com/attachments/1/2/persistent.png",
  };
  try {
    const firstStore = createPersistentVisionCache({ filePath });
    const firstClient = createVisionClient({
      enabled: true,
      apiKey: "test-key",
      cache: firstStore.cache,
      cachePersistence: firstStore,
      fetch: async () => {
        requests += 1;
        return new Response(JSON.stringify({
          model: "google/gemini-2.5-flash-lite",
          choices: [{ message: { content: JSON.stringify({ ocr: ["Kuro"], observation: "黑貓" }) } }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    await firstClient.describe([image], "這是什麼？");

    const secondStore = createPersistentVisionCache({ filePath });
    const secondClient = createVisionClient({
      enabled: true,
      apiKey: "test-key",
      cache: secondStore.cache,
      cachePersistence: secondStore,
      fetch: async () => {
        throw new Error("persisted cache should avoid provider call");
      },
    });
    const result = await secondClient.describe([image], "這是什麼？");
    assert.equal(result.cacheHit, true);
    assert.equal(requests, 1);
    assert.equal(secondClient.getCacheStats().loadedEntries, 2);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
