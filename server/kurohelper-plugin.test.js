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
  let dispatched;
  const dispatchedPromise = new Promise((resolve) => {
    dispatched = resolve;
  });
  const plugin = createKuroHelperPlugin(
    {
      isSillyTavernReady: () => true,
      onUserMessage: async () => {
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
      payload: { channelId: "channel-1", userId: "user-1", text: "hello" },
    }));
    await dispatchedPromise;
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
