import test from 'node:test';
import assert from 'node:assert/strict';

import {
  cacheRawReply,
  listRawReplyCache,
  RAW_REPLY_CACHE_LIMIT,
} from './raw-reply-cache.mjs';

test('retains only the five most recent raw replies', () => {
  const chat = [];
  for (let index = 0; index < RAW_REPLY_CACHE_LIMIT + 2; index += 1) {
    const message = { is_user: false, mes: `formatted-${index}`, extra: {} };
    chat.push(message);
    cacheRawReply(chat, message, `raw-${index}`, {
      cachedAt: `2026-08-02T00:00:0${index}.000Z`,
    });
  }

  assert.deepEqual(
    listRawReplyCache(chat).map((entry) => entry.rawText),
    ['raw-2', 'raw-3', 'raw-4', 'raw-5', 'raw-6'],
  );
  assert.equal(chat[0].extra.kurohelperRawReply, undefined);
  assert.equal(chat[1].extra.kurohelperRawReplyCachedAt, undefined);
});

test('stores the original text independently from the formatted message', () => {
  const message = { is_user: false, mes: '……嗯。', extra: {} };
  const chat = [message];

  cacheRawReply(chat, message, '……（低下頭）嗯。', {
    cachedAt: '2026-08-02T00:00:00.000Z',
  });

  assert.deepEqual(listRawReplyCache(chat), [
    {
      cachedAt: '2026-08-02T00:00:00.000Z',
      rawText: '……（低下頭）嗯。',
    },
  ]);
  assert.equal(message.mes, '……嗯。');
});

test('does not overwrite an existing raw reply with its formatted text', () => {
  const message = { is_user: false, mes: '……嗯。', extra: {} };
  const chat = [message];

  assert.equal(cacheRawReply(chat, message, '……（低下頭）嗯。'), true);
  assert.equal(cacheRawReply(chat, message, '……嗯。'), false);
  assert.equal(listRawReplyCache(chat)[0].rawText, '……（低下頭）嗯。');
});
