import test from 'node:test';
import assert from 'node:assert/strict';

import { formatDialogueOnly } from './dialogue-only.mjs';

test('removes full-line stage directions and keeps dialogue', () => {
  assert.equal(
    formatDialogueOnly(
      '「……餓了？」\n（Kuro微微垂下視線，貓耳動了動。）\n\n「……我這裡，有巧克力。」\n（她從口袋裡摸出巧克力，遞出去。）\n\n「……不苦的。」',
    ),
    '「……餓了？」\n\n「……我這裡，有巧克力。」\n\n「……不苦的。」',
  );
});

test('removes inline action directions', () => {
  assert.equal(
    formatDialogueOnly('……嗯。（低下頭，貓耳動了一下）我知道。'),
    '……嗯。我知道。',
  );
});

test('removes the observed inline pause and gaze direction', () => {
  assert.equal(
    formatDialogueOnly(
      '……（微微一頓，垂下目光）嗯……也是呢。對不起，多說了。',
    ),
    '……嗯……也是呢。對不起，多說了。',
  );
});

test('preserves informative parentheses in spoken text', () => {
  assert.equal(
    formatDialogueOnly('今天是七月二十六日（星期日）。'),
    '今天是七月二十六日（星期日）。',
  );
});

test('does not rewrite quoted speech or surrounding narration', () => {
  assert.equal(
    formatDialogueOnly('她低下頭，小聲說：「……今天是七月二十六日。」'),
    '她低下頭，小聲說：「……今天是七月二十六日。」',
  );
});

test('does not remove unparenthesized narration', () => {
  assert.equal(
    formatDialogueOnly('Kuro的貓耳動了一下。\n……我知道了。'),
    'Kuro的貓耳動了一下。\n……我知道了。',
  );
});

test('removes ASCII and full-width asterisk stage directions', () => {
  assert.equal(
    formatDialogueOnly('*耳朵輕輕抖了一下*\n……嗯。\n＊声音更轻了些＊\n……知道了。'),
    '……嗯。\n\n……知道了。',
  );
});

test('preserves ordinary asterisk emphasis', () => {
  assert.equal(
    formatDialogueOnly('這件事，*真的*很重要。'),
    '這件事，*真的*很重要。',
  );
});

test('preserves Chinese quotation marks used inside ordinary speech', () => {
  assert.equal(
    formatDialogueOnly(
      '夜之國像「記憶的圖書館」，也是「已經結束的時間的墳墓」。',
    ),
    '夜之國像「記憶的圖書館」，也是「已經結束的時間的墳墓」。',
  );
});
