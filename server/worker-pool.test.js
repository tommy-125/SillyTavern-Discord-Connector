"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createWorkerPool } = require("./worker-pool");

function socket() {
  return {
    readyState: 1,
    sent: [],
    send(value) {
      this.sent.push(JSON.parse(value));
    },
    close() {
      this.readyState = 3;
    },
  };
}

function task(channelId, requestId) {
  return {
    channelId,
    requestId,
    payload: { type: "user_message", chatId: channelId, requestId },
  };
}

test("different channels run concurrently", () => {
  const pool = createWorkerPool();
  const first = socket();
  const second = socket();
  pool.register("worker-1", first);
  pool.register("worker-2", second);

  assert.equal(pool.enqueue(task("channel-a", "request-a")), true);
  assert.equal(pool.enqueue(task("channel-b", "request-b")), true);

  assert.equal(first.sent.length, 1);
  assert.equal(second.sent.length, 1);
  assert.equal(pool.snapshot().busy, 2);
});

test("same channel remains FIFO while another channel may pass it", () => {
  const pool = createWorkerPool();
  const first = socket();
  const second = socket();
  pool.register("worker-1", first);
  pool.register("worker-2", second);

  pool.enqueue(task("channel-a", "request-a1"));
  pool.enqueue(task("channel-a", "request-a2"));
  pool.enqueue(task("channel-b", "request-b1"));

  assert.deepEqual(first.sent.map((item) => item.requestId), ["request-a1"]);
  assert.deepEqual(second.sent.map((item) => item.requestId), ["request-b1"]);
  assert.equal(pool.snapshot().queued, 1);

  assert.equal(pool.complete("worker-1", "request-a1"), true);
  assert.deepEqual(first.sent.map((item) => item.requestId), ["request-a1", "request-a2"]);
});

test("a disconnected busy worker retries once on another worker", () => {
  const pool = createWorkerPool();
  const first = socket();
  const second = socket();
  pool.register("worker-1", first);
  pool.register("worker-2", second);
  pool.enqueue(task("channel-a", "request-a"));

  pool.unregister("worker-1", first);

  assert.deepEqual(second.sent.map((item) => item.requestId), ["request-a"]);
  assert.equal(pool.snapshot().busy, 1);
});

test("duplicate request IDs are not enqueued twice", () => {
  const pool = createWorkerPool();
  const first = socket();
  pool.register("worker-1", first);
  pool.enqueue(task("channel-a", "request-a"));
  pool.enqueue(task("channel-a", "request-a"));

  assert.equal(first.sent.length, 1);
  assert.equal(pool.snapshot().queued, 0);
});
