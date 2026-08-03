"use strict";

const assert = require("node:assert/strict");
const net = require("node:net");
const test = require("node:test");
const WebSocket = require("ws");
const { createKuroHelperPlugin } = require("./plugins/kurohelper");

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function waitForMessage(socket) {
  return new Promise((resolve, reject) => {
    socket.once("message", (data) => resolve(JSON.parse(data.toString("utf8"))));
    socket.once("error", reject);
  });
}

test("KuroHelper transport rejects missing auth and answers authenticated health", async () => {
  const port = await reservePort();
  const plugin = createKuroHelperPlugin(
    {
      isSillyTavernReady: () => false,
      onUserMessage: async () => false,
      log: () => {},
    },
    { host: "127.0.0.1", port, secret: "test-secret" },
  );
  await plugin.start();

  try {
    const rejectedStatus = await new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}`);
      socket.once("unexpected-response", (_request, response) => {
        response.resume();
        resolve(response.statusCode);
      });
      socket.once("open", () => reject(new Error("unauthenticated socket opened")));
      socket.once("error", () => {});
    });
    assert.equal(rejectedStatus, 401);

    const socket = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { Authorization: "Bearer test-secret" },
    });
    await new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    socket.send(JSON.stringify({
      version: 1,
      type: "health_request",
      requestId: "health-1",
      payload: {},
    }));
    const response = await waitForMessage(socket);
    assert.equal(response.type, "health_response");
    assert.equal(response.requestId, "health-1");
    assert.equal(response.payload.status, "degraded");
    socket.close();
  } finally {
    await plugin.stop();
  }
});

test("KuroHelper transport returns generation metrics with the final reply", async () => {
  const port = await reservePort();
  let receivedMetadata;
  let dispatched;
  const dispatchedPromise = new Promise((resolve) => {
    dispatched = resolve;
  });
  const plugin = createKuroHelperPlugin(
    {
      isSillyTavernReady: () => true,
      onUserMessage: async (_platform, _channelId, _text, _userId, metadata) => {
        receivedMetadata = metadata;
        dispatched();
        return true;
      },
      log: () => {},
    },
    { host: "127.0.0.1", port, secret: "test-secret" },
  );
  await plugin.start();

  try {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { Authorization: "Bearer test-secret" },
    });
    await new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    socket.send(JSON.stringify({
      version: 1,
      type: "generate_request",
      requestId: "generation-1",
      payload: {
        channelId: "channel-1",
        userId: "user-1",
        text: "hello",
        recentMessages: [{
          id: "recent-1",
          userId: "user-2",
          displayName: "Bob",
          content: "earlier question",
          assistant: false,
          createdAt: "2026-08-01T01:00:00Z",
        }],
        images: [{
          id: "image-1",
          url: "https://cdn.discordapp.com/attachments/a/b/image.png",
          filename: "image.png",
          contentType: "image/png",
          size: 1234,
          messageId: "message-1",
          authorName: "Alice",
          contextOnly: true,
        }],
      },
    }));
    await dispatchedPromise;
    assert.equal(receivedMetadata.recentMessages.length, 1);
    assert.equal(receivedMetadata.recentMessages[0].displayName, "Bob");
    assert.deepEqual(receivedMetadata.images, [{
      id: "image-1",
      url: "https://cdn.discordapp.com/attachments/a/b/image.png",
      filename: "image.png",
      contentType: "image/png",
      size: 1234,
      messageId: "message-1",
      authorName: "Alice",
      contextOnly: true,
    }]);
    const responsePromise = waitForMessage(socket);
    await plugin.sendText("channel-1", "reply", {
      kind: "ai_reply",
      requestId: "generation-1",
      final: true,
      metrics: { status: "success", totalTokens: 42, costUsd: 0.001 },
    });
    const response = await responsePromise;
    assert.equal(response.type, "generate_response");
    assert.equal(response.payload.text, "reply");
    assert.equal(response.payload.metrics.totalTokens, 42);
    assert.equal(response.payload.metrics.costUsd, 0.001);
    socket.close();
  } finally {
    await plugin.stop();
  }
});

test("KuroHelper transport sends background memory metrics", async () => {
  const port = await reservePort();
  const plugin = createKuroHelperPlugin(
    {
      isSillyTavernReady: () => true,
      onUserMessage: async () => true,
      log: () => {},
    },
    { host: "127.0.0.1", port, secret: "test-secret" },
  );
  await plugin.start();

  try {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { Authorization: "Bearer test-secret" },
    });
    await new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    const responsePromise = waitForMessage(socket);
    await plugin.sendMetric("channel-1", {
      requestId: "generation-1:memory",
      operation: "memory_extraction",
      metrics: {
        status: "success",
        promptTokens: 300,
        completionTokens: 21,
        totalTokens: 321,
        costUsd: 0.0001,
      },
    });
    const response = await responsePromise;
    assert.equal(response.type, "metric_event");
    assert.equal(response.requestId, "generation-1:memory");
    assert.equal(response.payload.channelId, "channel-1");
    assert.equal(response.payload.operation, "memory_extraction");
    assert.equal(response.payload.metrics.totalTokens, 321);
    socket.close();
  } finally {
    await plugin.stop();
  }
});

test("KuroHelper transport returns the raw reply cache", async () => {
  const port = await reservePort();
  const entries = [{
    cachedAt: "2026-08-02T01:02:03.000Z",
    rawText: "……（低下頭）嗯。",
  }];
  const plugin = createKuroHelperPlugin(
    {
      isSillyTavernReady: () => true,
      listRawReplies: async () => ({ entries }),
      onUserMessage: async () => false,
      log: () => {},
    },
    { host: "127.0.0.1", port, secret: "test-secret" },
  );
  await plugin.start();

  try {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { Authorization: "Bearer test-secret" },
    });
    await new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    const responsePromise = waitForMessage(socket);
    socket.send(JSON.stringify({
      version: 1,
      type: "raw_replies_request",
      requestId: "raw-1",
      payload: {},
    }));
    const response = await responsePromise;
    assert.equal(response.type, "raw_replies_response");
    assert.equal(response.requestId, "raw-1");
    assert.deepEqual(response.payload.entries, entries);
    socket.close();
  } finally {
    await plugin.stop();
  }
});

test("KuroHelper transport reattaches in-flight duplicates and replays completed requests", async () => {
  const port = await reservePort();
  let dispatchCount = 0;
  let dispatched;
  const dispatchedPromise = new Promise((resolve) => {
    dispatched = resolve;
  });
  const plugin = createKuroHelperPlugin(
    {
      isSillyTavernReady: () => true,
      onUserMessage: async () => {
        dispatchCount += 1;
        dispatched();
        return true;
      },
      log: () => {},
    },
    { host: "127.0.0.1", port, secret: "test-secret" },
  );
  await plugin.start();

  try {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { Authorization: "Bearer test-secret" },
    });
    await new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    const request = JSON.stringify({
      version: 1,
      type: "generate_request",
      requestId: "same-discord-message",
      payload: { channelId: "channel-1", userId: "user-1", text: "hello" },
    });
    socket.send(request);
    await dispatchedPromise;
    socket.send(request);

    const firstResponsePromise = waitForMessage(socket);
    await plugin.sendText("channel-1", "reply", {
      kind: "ai_reply",
      requestId: "same-discord-message",
      final: true,
      metrics: { status: "success" },
    });
    const firstResponse = await firstResponsePromise;
    assert.equal(firstResponse.payload.text, "reply");

    const replayPromise = waitForMessage(socket);
    socket.send(request);
    const replay = await replayPromise;
    assert.equal(replay.type, "generate_response");
    assert.equal(replay.payload.text, "reply");
    assert.equal(dispatchCount, 1);

    const conflictPromise = waitForMessage(socket);
    socket.send(JSON.stringify({
      version: 1,
      type: "generate_request",
      requestId: "same-discord-message",
      payload: { channelId: "channel-1", userId: "user-1", text: "different" },
    }));
    const conflict = await conflictPromise;
    assert.equal(conflict.type, "error_response");
    assert.equal(conflict.error.code, "request_id_conflict");
    assert.equal(dispatchCount, 1);
    socket.close();
  } finally {
    await plugin.stop();
  }
});
