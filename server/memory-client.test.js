"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createMemoryClient } = require("./memory-client");

test("recall returns scoped context from memory service", async () => {
  let requestBody;
  const client = createMemoryClient({
    enabled: true,
    characterId: "Kuro",
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({ context: "remembered", memories: [{ id: "1" }] }),
      };
    },
  });

  const result = await client.recall({
    query: "咖啡",
    channelId: "discord:c1",
    participantIds: ["u1", "u2"],
  });
  assert.equal(result.context, "remembered");
  assert.equal(requestBody.user_id, undefined);
  assert.equal(requestBody.character_id, "Kuro");
  assert.equal(requestBody.channel_id, "discord:c1");
  assert.deepEqual(requestBody.participant_ids, ["u1", "u2"]);
});

test("recall fails open when service is unavailable", async () => {
  const client = createMemoryClient({
    enabled: true,
    fetchImpl: async () => {
      throw new Error("offline");
    },
  });
  const result = await client.recall({ query: "hello" });
  assert.equal(result.context, "");
  assert.deepEqual(result.memories, []);
});

test("disabled client does not call the service", async () => {
  let called = false;
  const client = createMemoryClient({
    enabled: false,
    fetchImpl: async () => {
      called = true;
    },
  });
  await client.recall({ query: "hello" });
  assert.equal(called, false);
});

test("rememberTurn submits extraction after generation", async () => {
  let requestBody;
  const client = createMemoryClient({
    enabled: true,
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({
          status: "completed",
          metrics: { totalTokens: 321, costUsd: 0.0001 },
        }),
      };
    },
  });
  const saved = await client.rememberTurn({
    requestId: "r1",
    userId: "u1",
    channelId: "c1",
    displayName: "肉圓",
    mentionedUsers: [{ id: "u2", displayName: "Tommy" }],
    contextParticipants: [
      { id: "u1", displayName: "肉圓" },
      { id: "u3", displayName: "海獺" },
    ],
    recentContext: "[海獺] 大家星期六要玩遊戲嗎？",
    userText: "我喜歡咖啡",
    assistantText: "……記住了。",
  });
  assert.equal(saved.status, "completed");
  assert.equal(saved.metrics.totalTokens, 321);
  assert.equal(requestBody.user_text, "我喜歡咖啡");
  assert.deepEqual(requestBody.mentioned_users, [
    { id: "u2", display_name: "Tommy" },
  ]);
  assert.deepEqual(requestBody.context_participants, [
    { id: "u1", display_name: "肉圓" },
    { id: "u3", display_name: "海獺" },
  ]);
  assert.equal(requestBody.recent_context, "[海獺] 大家星期六要玩遊戲嗎？");
});

test("memory management uses the shared character scope", async () => {
  const requests = [];
  const client = createMemoryClient({
    enabled: true,
    characterId: "Kuro",
    fetchImpl: async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body) });
      return {
        ok: true,
        json: async () => ({ status: "ok", memories: [] }),
      };
    },
  });

  await client.listMemories({ status: "deleted", limit: 12, offset: 24 });
  await client.getMemory("abcdef12");
  await client.forgetMemory("abcdef12");
  await client.restoreMemory("abcdef12");
  await client.clearMemories();
  await client.listBackups({ limit: 5, offset: 10 });
  await client.createBackup();
  await client.restoreBackup("20260730T120000Z-manual-abcdef12");

  assert.deepEqual(
    requests.map((request) => request.url.split("/").at(-1)),
    ["list", "get", "forget", "restore", "clear", "backups", "backup", "restore-backup"],
  );
  assert.ok(requests.every((request) => request.body.character_id === "Kuro"));
  assert.equal(requests[0].body.status, "deleted");
  assert.equal(requests[0].body.limit, 12);
  assert.equal(requests[0].body.offset, 24);
  assert.equal(requests[1].body.memory_id, "abcdef12");
  assert.equal(requests[2].body.memory_id, "abcdef12");
  assert.equal(requests[5].body.limit, 5);
  assert.equal(requests[5].body.offset, 10);
  assert.equal(requests[7].body.backup_id, "20260730T120000Z-manual-abcdef12");
});
