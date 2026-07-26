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

test('preserves informative parentheses in spoken text', () => {
  assert.equal(
    formatDialogueOnly('今天是七月二十六日（星期日）。'),
    '今天是七月二十六日（星期日）。',
  );
});

test('keeps quoted speech when narration shares the same line', () => {
  assert.equal(
    formatDialogueOnly('她低下頭，小聲說：「……今天是七月二十六日。」'),
    '「……今天是七月二十六日。」',
  );
});

test('removes unquoted third-person narration', () => {
  assert.equal(
    formatDialogueOnly('Kuro的貓耳動了一下。\n……我知道了。'),
    '……我知道了。',
  );
});
