import test from 'node:test';
import assert from 'node:assert/strict';

import { looksLikePromptLeak } from './model-output-guard.mjs';

const phi =
  '直接以{{char}}的中文口語回應{{user}}當下的訊息，先回答對方的問題或承接話題，再保持短句、停頓、害羞、低聲、笨拙而真誠。只輸出{{char}}在當下對{{user}}的實際回應。';

test('detects a verbatim instruction replay', () => {
  assert.equal(looksLikePromptLeak(phi, phi), true);
});

test('detects instruction-shaped output from an older prompt', () => {
  assert.equal(
    looksLikePromptLeak(
      '避免一開始重複動作描寫，保持角色的語言習慣。不要在每次回覆結尾加入停頓，並遵守回覆規則，只輸出角色回應。',
      phi,
    ),
    true,
  );
});

test('preserves an ordinary long in-character reply', () => {
  assert.equal(
    looksLikePromptLeak(
      '……運勢嗎？我不太會占卜。不過，今天可以先把想做的事情慢慢完成。出門記得帶水，晚上如果累了，就早一點回來。這只是笨貓的感覺……但我希望你今天會過得很好。',
      phi,
    ),
    false,
  );
});

test('detects a short hallucinated third-person role instruction', () => {
  assert.equal(
    looksLikePromptLeak(
      '若肉圓長期沉默，Kuro可先沉默陪著、說晚安或問「睡著了嗎？」。',
      phi,
    ),
    true,
  );
});
