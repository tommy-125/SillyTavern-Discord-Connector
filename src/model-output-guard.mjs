/**
 * Detect model replies that repeat card instructions instead of answering.
 *
 * This guard is intentionally narrow: it does not rewrite roleplay text or
 * remove action narration. It only recognizes instruction-shaped output so a
 * final-only Discord delivery can retry before exposing prompt content.
 */

function normalize(value) {
  return String(value ?? '')
    .replace(/\{\{(?:char|user)\}\}/giu, '')
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .toLocaleLowerCase();
}

function chunks(value, size = 24) {
  const normalized = normalize(value);
  const result = [];
  for (let index = 0; index + size <= normalized.length; index += size) {
    result.push(normalized.slice(index, index + size));
  }
  return result;
}

/**
 * Returns true only when a substantial reply resembles prompt instructions.
 */
export function looksLikePromptLeak(text, instructions = '') {
  const output = String(text ?? '').trim();

  // In-character replies use first-person speech. A short third-person rule
  // such as "若肉圓……Kuro可……" is instruction leakage even when it is too
  // short to compare reliably with the source prompt.
  if (
    /^(?:若|如果|當).{0,40}(?:Kuro|小黑|角色).{0,12}(?:可|應|應該|需要|必須|會先)/u.test(
      output,
    )
  ) {
    return true;
  }

  if (normalize(output).length < 24) return false;

  const instructionChunks = chunks(instructions);
  if (
    instructionChunks.length > 0 &&
    instructionChunks.some((chunk) => normalize(output).includes(chunk))
  ) {
    return true;
  }

  const instructionSignals = [
    /(?:角色卡|系統指令|提示詞|回覆規則)/u,
    /(?:只輸出|不得複述|直接以).{0,20}(?:回應|訊息|口語)/u,
    /(?:保持|避免|不要).{0,20}(?:角色|回覆|描寫|措辭|停頓)/u,
  ];

  return instructionSignals.filter((pattern) => pattern.test(output)).length >= 2;
}
