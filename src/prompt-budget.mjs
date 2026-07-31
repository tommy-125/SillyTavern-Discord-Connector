export const DEFAULT_RECENT_CHANNEL_TOKEN_BUDGET = 500;
export const DEFAULT_MEMORY_TOKEN_BUDGET = 400;

const SEGMENT_PATTERN =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[\p{L}\p{N}_]+|\s+|[^\s]/gu;

function segmentCost(segment) {
  if (/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]$/u.test(segment)) {
    return 1;
  }
  if (/^[\p{L}\p{N}_]+$/u.test(segment)) {
    return Math.max(1, Math.ceil([...segment].length / 4));
  }
  if (/^\s+$/u.test(segment)) {
    return Math.max(1, Math.ceil(segment.length / 8));
  }
  if (/\p{Extended_Pictographic}/u.test(segment)) return 2;
  return 1;
}

function tokenizeEstimate(text) {
  return [...String(text || '').matchAll(SEGMENT_PATTERN)].map((match) => ({
    text: match[0],
    tokens: segmentCost(match[0]),
  }));
}

export function estimatePromptTokens(text) {
  return tokenizeEstimate(text).reduce((sum, segment) => sum + segment.tokens, 0);
}

/**
 * Conservatively cap dynamic prompt text without depending on SillyTavern's
 * model tokenizer. Recent channel context keeps its newest tail; ranked memory
 * keeps its highest-priority prefix.
 */
export function truncatePromptToTokenBudget(text, maxTokens, { keep = 'start' } = {}) {
  const normalized = String(text || '').trim();
  if (!normalized) return '';
  if (!Number.isInteger(maxTokens) || maxTokens <= 0) return '';

  const segments = tokenizeEstimate(normalized);
  const total = segments.reduce((sum, segment) => sum + segment.tokens, 0);
  if (total <= maxTokens) return normalized;

  const marker = '…';
  const contentBudget = Math.max(0, maxTokens - segmentCost(marker));
  const selected = [];
  let used = 0;

  if (keep === 'end') {
    for (let index = segments.length - 1; index >= 0; index -= 1) {
      const segment = segments[index];
      if (used + segment.tokens > contentBudget) break;
      selected.unshift(segment.text);
      used += segment.tokens;
    }
    return `${marker}${selected.join('')}`.trim();
  }

  for (const segment of segments) {
    if (used + segment.tokens > contentBudget) break;
    selected.push(segment.text);
    used += segment.tokens;
  }
  return `${selected.join('').trimEnd()}${marker}`;
}

export function buildBudgetedDynamicContexts({
  recentChannelContext,
  memoryContext,
  recentTokenBudget = DEFAULT_RECENT_CHANNEL_TOKEN_BUDGET,
  memoryTokenBudget = DEFAULT_MEMORY_TOKEN_BUDGET,
} = {}) {
  return {
    recentChannelContext: truncatePromptToTokenBudget(
      recentChannelContext,
      recentTokenBudget,
      { keep: 'end' },
    ),
    memoryContext: truncatePromptToTokenBudget(memoryContext, memoryTokenBudget, {
      keep: 'start',
    }),
  };
}
