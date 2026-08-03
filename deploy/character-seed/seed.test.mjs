import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  convertCharacterBook,
  seedCharacterAndLorebook,
} from './seed.mjs';

const sampleEntry = {
  id: 271,
  keys: ['A地點', 'B地點', '時間分枝'],
  secondary_keys: [],
  comment: '大雅用魔法切開的時間分枝',
  content: '{{char}}記得時間分枝。',
  constant: false,
  selective: true,
  insertion_order: 100,
  enabled: true,
  position: 'before_char',
  extensions: {
    position: 0,
    display_index: 271,
    probability: 100,
    useProbability: true,
    depth: 4,
    selectiveLogic: 0,
    vectorized: false,
    ignore_budget: false,
  },
};

test('convertCharacterBook mirrors SillyTavern world-info fields', () => {
  const converted = convertCharacterBook({
    name: 'Kuro',
    entries: [sampleEntry],
  });
  const entry = converted.entries['271'];

  assert.equal(entry.uid, 271);
  assert.deepEqual(entry.key, sampleEntry.keys);
  assert.deepEqual(entry.keysecondary, []);
  assert.equal(entry.comment, sampleEntry.comment);
  assert.equal(entry.content, sampleEntry.content);
  assert.equal(entry.order, 100);
  assert.equal(entry.position, 0);
  assert.equal(entry.disable, false);
  assert.equal(entry.displayIndex, 271);
  assert.equal(entry.probability, 100);
  assert.equal(entry.depth, 4);
  assert.equal(entry.vectorized, false);
  assert.equal(entry.ignoreBudget, false);
  assert.deepEqual(converted.originalData.entries[0], sampleEntry);
});

test('convertCharacterBook rejects duplicate entry ids', () => {
  assert.throws(
    () => convertCharacterBook({
      name: 'Kuro',
      entries: [sampleEntry, { ...sampleEntry }],
    }),
    /duplicate entry id 271/,
  );
});

test('convertCharacterBook can place dynamic lore at chat depth', () => {
  const converted = convertCharacterBook(
    { name: 'Kuro', entries: [sampleEntry] },
    { positionOverride: 4, depthOverride: 4, roleOverride: 0 },
  );

  assert.equal(converted.entries['271'].position, 4);
  assert.equal(converted.entries['271'].depth, 4);
  assert.equal(converted.entries['271'].role, 0);
  assert.equal(converted.originalData.entries[0].position, 'before_char');
});

test('seedCharacterAndLorebook synchronizes the card and linked lorebook', (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kuro-seed-'));
  t.after(() => fs.rmSync(temporaryRoot, { force: true, recursive: true }));

  const sourceJson = path.join(temporaryRoot, 'card.json');
  const sourcePng = path.join(temporaryRoot, 'card.png');
  const dataRoot = path.join(temporaryRoot, 'data', 'default-user');
  fs.writeFileSync(sourcePng, Buffer.from('test-png'));
  fs.writeFileSync(sourceJson, JSON.stringify({
    data: {
      extensions: { world: 'Kuro' },
      character_book: { name: 'Kuro', entries: [sampleEntry] },
    },
  }));

  const first = seedCharacterAndLorebook({
    characterJsonPath: sourceJson,
    characterPngPath: sourcePng,
    dataRoot,
  });
  assert.equal(first.characterChanged, true);
  assert.equal(first.worldChanged, true);
  assert.equal(first.entryCount, 1);
  assert.deepEqual(fs.readFileSync(first.characterTarget), Buffer.from('test-png'));

  const savedWorld = JSON.parse(fs.readFileSync(first.worldTarget, 'utf8'));
  assert.equal(savedWorld.entries['271'].uid, 271);
  assert.equal(savedWorld.entries['271'].position, 4);
  assert.equal(savedWorld.entries['271'].depth, 4);
  assert.equal(savedWorld.entries['271'].role, 0);
  assert.equal(savedWorld.originalData.name, 'Kuro');

  const second = seedCharacterAndLorebook({
    characterJsonPath: sourceJson,
    characterPngPath: sourcePng,
    dataRoot,
  });
  assert.equal(second.characterChanged, false);
  assert.equal(second.worldChanged, false);
});

test('seedCharacterAndLorebook rejects an unlinked embedded lorebook', (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kuro-seed-'));
  t.after(() => fs.rmSync(temporaryRoot, { force: true, recursive: true }));

  const sourceJson = path.join(temporaryRoot, 'card.json');
  const sourcePng = path.join(temporaryRoot, 'card.png');
  fs.writeFileSync(sourcePng, Buffer.from('test-png'));
  fs.writeFileSync(sourceJson, JSON.stringify({
    data: {
      extensions: {},
      character_book: { name: 'Kuro', entries: [sampleEntry] },
    },
  }));

  assert.throws(
    () => seedCharacterAndLorebook({
      characterJsonPath: sourceJson,
      characterPngPath: sourcePng,
      dataRoot: path.join(temporaryRoot, 'data'),
    }),
    /must set data\.extensions\.world/,
  );
});
