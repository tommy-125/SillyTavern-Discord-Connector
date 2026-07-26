/**
 * Remove model-protocol markers that occasionally leak through OpenRouter.
 * These tokens delimit DeepSeek turns and are not user-facing content.
 */

'use strict';

const DEEPSEEK_SENTENCE_MARKER =
  /<(?:\||｜)(?:begin|end)(?:▁|_|\s)*of(?:▁|_|\s)*sentence(?:\||｜)>/giu;

function sanitizeModelOutput(text) {
  return String(text ?? '').replace(DEEPSEEK_SENTENCE_MARKER, '').trim();
}

module.exports = { sanitizeModelOutput };
