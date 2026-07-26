'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { prepareIncomingContent } = require('./message-trigger');

test('accepts every message when no trigger prefix is configured', () => {
  assert.deepEqual(
    prepareIncomingContent({
      content: 'hello',
      triggerPrefix: undefined,
      botUserId: '42',
      isBotMentioned: false,
    }),
    { accepted: true, content: 'hello' },
  );
});

test('accepts and preserves the configured trigger prefix', () => {
  assert.deepEqual(
    prepareIncomingContent({
      content: '小黑 你好',
      triggerPrefix: '小黑',
      botUserId: '42',
      isBotMentioned: false,
    }),
    { accepted: true, content: '小黑 你好' },
  );
});

test('preserves the trigger prefix while removing a Discord mention', () => {
  assert.deepEqual(
    prepareIncomingContent({
      content: '小黑 <@42> 你好',
      triggerPrefix: '小黑',
      botUserId: '42',
      isBotMentioned: true,
    }),
    { accepted: true, content: '小黑 你好' },
  );
});

test('rejects unaddressed messages when a trigger prefix is configured', () => {
  assert.equal(
    prepareIncomingContent({
      content: '大家好',
      triggerPrefix: '小黑',
      botUserId: '42',
      isBotMentioned: false,
    }).accepted,
    false,
  );
});

test('accepts a bot mention as an alternative trigger and strips it', () => {
  assert.deepEqual(
    prepareIncomingContent({
      content: '<@42> 你好',
      triggerPrefix: '小黑',
      botUserId: '42',
      isBotMentioned: true,
    }),
    { accepted: true, content: '你好' },
  );
});

test('strips Discord nickname mention syntax too', () => {
  assert.deepEqual(
    prepareIncomingContent({
      content: '請問 <@!42> 今天好嗎',
      triggerPrefix: '小黑',
      botUserId: '42',
      isBotMentioned: true,
    }),
    { accepted: true, content: '請問 今天好嗎' },
  );
});
