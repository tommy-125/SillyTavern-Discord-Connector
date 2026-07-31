import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBudgetedDynamicContexts,
  estimatePromptTokens,
  truncatePromptToTokenBudget,
} from './prompt-budget.mjs';

test('estimates CJK text conservatively', () => {
  assert.equal(estimatePromptTokens('今天星期五'), 5);
  assert.equal(estimatePromptTokens('OpenRouter'), 3);
});

test('recent context keeps the newest tail within its token budget', () => {
  const value = truncatePromptToTokenBudget(
    `舊${'甲'.repeat(20)}\n最新：明天一起玩`,
    10,
    { keep: 'end' },
  );
  assert.ok(value.startsWith('…'));
  assert.match(value, /明天一起玩$/);
  assert.ok(estimatePromptTokens(value) <= 10);
});

test('memory keeps its highest-ranked prefix within its token budget', () => {
  const value = truncatePromptToTokenBudget(
    `核心記憶：喜歡牛奶巧克力\n${'次要'.repeat(20)}`,
    15,
  );
  assert.ok(value.endsWith('…'));
  assert.match(value, /^核心記憶/);
  assert.ok(estimatePromptTokens(value) <= 15);
});

test('buildBudgetedDynamicContexts applies independent budgets', () => {
  const result = buildBudgetedDynamicContexts({
    recentChannelContext: '近'.repeat(20),
    memoryContext: '憶'.repeat(20),
    recentTokenBudget: 8,
    memoryTokenBudget: 5,
  });
  assert.ok(estimatePromptTokens(result.recentChannelContext) <= 8);
  assert.ok(estimatePromptTokens(result.memoryContext) <= 5);
});
