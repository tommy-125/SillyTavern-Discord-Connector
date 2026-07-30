import test from 'node:test';
import assert from 'node:assert/strict';
import { suppressPreviousChatMessages } from './prompt-history.mjs';

test('suppresses persisted messages except the current user message', () => {
  const ignore = Symbol.for('ignore-test');
  const chat = [
    { is_user: false, mes: 'opening', extra: {} },
    { is_user: true, mes: 'old question' },
    { is_user: false, mes: 'old answer', extra: {} },
    { is_user: true, mes: 'current question', extra: {} },
  ];
  const restore = suppressPreviousChatMessages(chat, ignore);
  assert.equal(chat[0].extra[ignore], true);
  assert.equal(chat[1].extra[ignore], true);
  assert.equal(chat[2].extra[ignore], true);
  assert.equal(chat[3].extra[ignore], undefined);
  restore();
  assert.equal(chat[0].extra[ignore], undefined);
  assert.equal(chat[1].extra, undefined);
  assert.equal(chat[2].extra[ignore], undefined);
});

test('preserves messages that were already manually hidden', () => {
  const ignore = Symbol.for('ignore-test-existing');
  const chat = [
    { is_user: false, extra: { [ignore]: true } },
    { is_user: true, extra: {} },
  ];
  const restore = suppressPreviousChatMessages(chat, ignore);
  restore();
  assert.equal(chat[0].extra[ignore], true);
});

test('does nothing unless the newest message is a user message', () => {
  const ignore = Symbol.for('ignore-test-invalid');
  const chat = [{ is_user: false, extra: {} }];
  suppressPreviousChatMessages(chat, ignore)();
  assert.equal(chat[0].extra[ignore], undefined);
});
