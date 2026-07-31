'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadQueueModule() {
  const moduleUrl = pathToFileURL(
    path.join(__dirname, '..', 'src', 'generation-queue.mjs'),
  );
  moduleUrl.searchParams.set('test', `${Date.now()}-${Math.random()}`);
  return import(moduleUrl.href);
}

async function wait(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

test('generation queue runs tasks globally in FIFO order', async () => {
  const { createGenerationQueue } = await loadQueueModule();
  const queue = createGenerationQueue();
  const events = [];
  let active = 0;
  let maxActive = 0;

  const first = queue.enqueue(async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    events.push('first:start');
    await wait(25);
    events.push('first:end');
    active -= 1;
  });
  const second = queue.enqueue(async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    events.push('second:start');
    await wait(5);
    events.push('second:end');
    active -= 1;
  });

  await Promise.all([first, second]);
  assert.equal(maxActive, 1);
  assert.deepEqual(events, [
    'first:start',
    'first:end',
    'second:start',
    'second:end',
  ]);
  assert.equal(queue.getPendingCount(), 0);
});

test('generation queue continues after a rejected task', async () => {
  const { createGenerationQueue } = await loadQueueModule();
  const queue = createGenerationQueue();
  const failure = queue.enqueue(async () => {
    throw new Error('expected failure');
  });
  const events = [];
  const recovery = queue.enqueue(async () => {
    events.push('recovered');
  });

  await assert.rejects(failure, /expected failure/);
  await recovery;
  assert.deepEqual(events, ['recovered']);
  assert.equal(queue.getPendingCount(), 0);
});

test('generation watchdog aborts a stuck task before the next task starts', async () => {
  const { createGenerationQueue, GenerationQueueTimeoutError } =
    await loadQueueModule();
  const queue = createGenerationQueue();
  const events = [];
  const stuck = queue.enqueue(
    ({ signal }) =>
      new Promise((resolve, reject) => {
        events.push('first:start');
        signal.addEventListener(
          'abort',
          () => {
            events.push('first:aborted');
            reject(signal.reason);
          },
          { once: true },
        );
      }),
    { timeoutMs: 15 },
  );
  const next = queue.enqueue(async () => {
    events.push('second:start');
  });

  await assert.rejects(stuck, GenerationQueueTimeoutError);
  await next;
  assert.deepEqual(events, ['first:start', 'first:aborted', 'second:start']);
  assert.equal(queue.getPendingCount(), 0);
});

test('generation watchdog requests recovery when abort is ignored', async () => {
  const { createGenerationQueue } = await loadQueueModule();
  const queue = createGenerationQueue();
  let release;
  const unresponsive = new Promise((resolve) => {
    queue.enqueue(
      () =>
        new Promise((taskResolve) => {
          release = taskResolve;
        }),
      {
        timeoutMs: 5,
        unresponsiveGraceMs: 5,
        onUnresponsive: resolve,
      },
    );
  });

  await unresponsive;
  assert.equal(queue.getPendingCount(), 1);
  release();
  await queue.whenIdle();
  assert.equal(queue.getPendingCount(), 0);
});
