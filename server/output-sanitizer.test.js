'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeModelOutput } = require('./output-sanitizer');

test('removes DeepSeek full-width sentence markers', () => {
  assert.equal(
    sanitizeModelOutput('<｜begin▁of▁sentence｜>你好<｜end▁of▁sentence｜>'),
    '你好',
  );
});

test('removes ASCII sentence marker variants', () => {
  assert.equal(sanitizeModelOutput('<|end_of_sentence|>'), '');
});

test('preserves ordinary model output', () => {
  assert.equal(sanitizeModelOutput('……早安。'), '……早安。');
});
