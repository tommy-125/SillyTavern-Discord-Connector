#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ENTRY = Object.freeze({
  key: [],
  keysecondary: [],
  comment: '',
  content: '',
  constant: false,
  vectorized: false,
  selective: true,
  selectiveLogic: 0,
  addMemo: false,
  order: 100,
  position: 0,
  disable: false,
  ignoreBudget: false,
  excludeRecursion: false,
  preventRecursion: false,
  matchPersonaDescription: false,
  matchCharacterDescription: false,
  matchCharacterPersonality: false,
  matchCharacterDepthPrompt: false,
  matchScenario: false,
  matchCreatorNotes: false,
  delayUntilRecursion: 0,
  probability: 100,
  useProbability: true,
  depth: 4,
  outletName: '',
  group: '',
  groupOverride: false,
  groupWeight: 100,
  scanDepth: null,
  caseSensitive: null,
  matchWholeWords: null,
  useGroupScoring: null,
  automationId: '',
  role: 0,
  sticky: null,
  cooldown: null,
  delay: null,
  triggers: [],
});

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }

  return value;
}

function validateWorldName(value) {
  const name = String(value || '').trim();
  if (!name) throw new Error('Character card must define a lorebook name');
  if (name === '.' || name === '..' || /[<>:"/\\|?*\u0000-\u001F]/u.test(name)) {
    throw new Error(`Unsafe SillyTavern lorebook name: ${JSON.stringify(name)}`);
  }

  return name;
}

function normalizeCharacterBook(characterBook) {
  const book = structuredClone(requireObject(characterBook, 'data.character_book'));
  if (!Array.isArray(book.entries)) {
    throw new Error('data.character_book.entries must be an array');
  }

  const seenIds = new Set();
  book.entries.forEach((entry, index) => {
    requireObject(entry, `data.character_book.entries[${index}]`);
    entry.id ??= index;

    if (!Number.isInteger(entry.id) || entry.id < 0) {
      throw new Error(`Lorebook entry at index ${index} has an invalid id`);
    }
    if (seenIds.has(entry.id)) {
      throw new Error(`Lorebook contains duplicate entry id ${entry.id}`);
    }

    seenIds.add(entry.id);
  });

  return book;
}

/**
 * Mirrors SillyTavern 1.18's convertCharacterBook() field mapping.
 * The original Character Card book is retained so SillyTavern can export it
 * back into the card without losing portable Character Card fields.
 */
export function convertCharacterBook(characterBook, {
  positionOverride = null,
  depthOverride = null,
  roleOverride = null,
} = {}) {
  const book = normalizeCharacterBook(characterBook);
  const entries = {};

  for (const [index, entry] of book.entries.entries()) {
    const extensions = entry.extensions || {};
    const sourcePosition = extensions.position
      ?? (entry.position === 'before_char' ? 0 : 1);

    entries[entry.id] = {
      ...structuredClone(DEFAULT_ENTRY),
      uid: entry.id,
      key: Array.isArray(entry.keys) ? entry.keys : [],
      keysecondary: Array.isArray(entry.secondary_keys)
        ? entry.secondary_keys
        : [],
      comment: entry.comment || '',
      content: entry.content || '',
      constant: entry.constant || false,
      selective: entry.selective || false,
      order: entry.insertion_order ?? 100,
      position: positionOverride ?? sourcePosition,
      excludeRecursion: extensions.exclude_recursion ?? false,
      preventRecursion: extensions.prevent_recursion ?? false,
      delayUntilRecursion: extensions.delay_until_recursion ?? false,
      disable: !entry.enabled,
      addMemo: Boolean(entry.comment),
      displayIndex: extensions.display_index ?? index,
      probability: extensions.probability ?? 100,
      useProbability: extensions.useProbability ?? true,
      depth: depthOverride ?? extensions.depth ?? 4,
      selectiveLogic: extensions.selectiveLogic ?? 0,
      outletName: extensions.outlet_name ?? '',
      group: extensions.group ?? '',
      groupOverride: extensions.group_override ?? false,
      groupWeight: extensions.group_weight ?? 100,
      scanDepth: extensions.scan_depth ?? null,
      caseSensitive: extensions.case_sensitive ?? null,
      matchWholeWords: extensions.match_whole_words ?? null,
      useGroupScoring: extensions.use_group_scoring ?? null,
      automationId: extensions.automation_id ?? '',
      role: roleOverride ?? extensions.role ?? 0,
      vectorized: extensions.vectorized ?? false,
      sticky: extensions.sticky ?? null,
      cooldown: extensions.cooldown ?? null,
      delay: extensions.delay ?? null,
      matchPersonaDescription:
        extensions.match_persona_description ?? false,
      matchCharacterDescription:
        extensions.match_character_description ?? false,
      matchCharacterPersonality:
        extensions.match_character_personality ?? false,
      matchCharacterDepthPrompt:
        extensions.match_character_depth_prompt ?? false,
      matchScenario: extensions.match_scenario ?? false,
      matchCreatorNotes: extensions.match_creator_notes ?? false,
      extensions,
      triggers: Array.isArray(extensions.triggers) ? extensions.triggers : [],
      ignoreBudget: extensions.ignore_budget ?? false,
    };
  }

  return { entries, originalData: book };
}

function writeFileIfChanged(targetPath, content, options = {}) {
  const next = Buffer.isBuffer(content) ? content : Buffer.from(content);

  try {
    const current = fs.readFileSync(targetPath);
    if (current.equals(next)) return false;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const temporaryPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;

  try {
    fs.writeFileSync(temporaryPath, next, { mode: options.mode ?? 0o644 });
    fs.renameSync(temporaryPath, targetPath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }

  return true;
}

export function seedCharacterAndLorebook({
  characterJsonPath,
  characterPngPath,
  dataRoot,
  characterFileName = 'Kuro.png',
  configuredWorldName = '',
  lorebookPosition = 4,
  lorebookDepth = 4,
  lorebookRole = 0,
}) {
  const card = JSON.parse(fs.readFileSync(characterJsonPath, 'utf8'));
  const data = requireObject(card.data || card, 'character card data');
  const characterBook = requireObject(
    data.character_book,
    'data.character_book',
  );
  const linkedWorldName = String(data.extensions?.world || '').trim();
  const embeddedWorldName = String(characterBook.name || '').trim();
  const worldName = validateWorldName(
    configuredWorldName || linkedWorldName || embeddedWorldName,
  );

  if (!linkedWorldName) {
    throw new Error(
      `Character card must set data.extensions.world to ${JSON.stringify(worldName)}`,
    );
  }
  if (linkedWorldName !== worldName) {
    throw new Error(
      `Character links world ${JSON.stringify(linkedWorldName)}, but seed targets ${JSON.stringify(worldName)}`,
    );
  }
  if (embeddedWorldName && embeddedWorldName !== worldName) {
    throw new Error(
      `Embedded book is named ${JSON.stringify(embeddedWorldName)}, but character links ${JSON.stringify(worldName)}`,
    );
  }

  const characterTarget = path.join(dataRoot, 'characters', characterFileName);
  const worldTarget = path.join(dataRoot, 'worlds', `${worldName}.json`);
  const worldInfo = convertCharacterBook(characterBook, {
    positionOverride: lorebookPosition,
    depthOverride: lorebookDepth,
    roleOverride: lorebookRole,
  });
  const characterChanged = writeFileIfChanged(
    characterTarget,
    fs.readFileSync(characterPngPath),
  );
  const worldChanged = writeFileIfChanged(
    worldTarget,
    `${JSON.stringify(worldInfo, null, 4)}\n`,
  );

  return {
    characterChanged,
    characterTarget,
    entryCount: Object.keys(worldInfo.entries).length,
    worldChanged,
    worldName,
    worldTarget,
  };
}

function runFromEnvironment() {
  const integerSetting = (name, fallback) => {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`${name} must be a non-negative integer`);
    }
    return value;
  };

  const result = seedCharacterAndLorebook({
    characterJsonPath:
      process.env.ST_CHARACTER_JSON_SOURCE_PATH || '/seed/character.json',
    characterPngPath:
      process.env.ST_CHARACTER_PNG_SOURCE_PATH || '/seed/character.png',
    dataRoot: process.env.ST_DATA_ROOT || '/data/default-user',
    characterFileName: process.env.ST_CHARACTER_FILE_NAME || 'Kuro.png',
    configuredWorldName: process.env.ST_CHARACTER_WORLD_NAME || '',
    lorebookPosition: integerSetting('ST_CHARACTER_LOREBOOK_POSITION', 4),
    lorebookDepth: integerSetting('ST_CHARACTER_LOREBOOK_DEPTH', 4),
    lorebookRole: integerSetting('ST_CHARACTER_LOREBOOK_ROLE', 0),
  });

  console.log(
    result.characterChanged
      ? `Synchronized character card: ${result.characterTarget}`
      : `Character card is already current: ${result.characterTarget}`,
  );
  console.log(
    result.worldChanged
      ? `Synchronized character lorebook: ${result.worldTarget} (${result.entryCount} entries)`
      : `Character lorebook is already current: ${result.worldTarget} (${result.entryCount} entries)`,
  );
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    runFromEnvironment();
  } catch (error) {
    console.error(`[character-seed] ${error.stack || error.message || error}`);
    process.exitCode = 1;
  }
}
