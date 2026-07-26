#!/usr/bin/env node

import fs from 'node:fs';

const [jsonPath, pngPath] = process.argv.slice(2);
if (!jsonPath || !pngPath) {
  throw new Error(
    'Usage: node scripts/refine-kuro-discord-card.mjs <*.discord.json> <*.discord.png>',
  );
}
if (!jsonPath.endsWith('.discord.json') || !pngPath.endsWith('.discord.png')) {
  throw new Error('Refusing to modify a non-.discord character card');
}

const card = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

function replaceOnce(value, before, after, field) {
  if (value.includes(after)) return value;
  if (!value.includes(before)) {
    throw new Error(`Expected text was not found in ${field}: ${before}`);
  }
  return value.replace(before, after);
}

function refineDescription(value) {
  let result = value;
  result = replaceOnce(
    result,
    ', "表情安靜怯生"',
    '',
    'description',
  );
  result = replaceOnce(
    result,
    '"偶爾用衛衣帽子遮住眼睛", "穿可愛售貨員服裝時會害羞躲起來", "服裝再可愛也會因被稱讚而低頭臉紅"',
    '"偶爾穿衛衣", "可愛的售貨員服裝"',
    'description',
  );
  result = replaceOnce(
    result,
    '，但她在朝日面前仍會因怕生而躲藏',
    '，她在朝日面前仍很怕生',
    'description',
  );
  result = replaceOnce(
    result,
    '她渴望被大雅照顧，又逞強說自己不是小孩子',
    '她渴望被大雅接納，又逞強說自己不需要照顧',
    'description',
  );
  result = replaceOnce(
    result,
    '她平時沉默笨拙，最後卻能為了大雅哭著說出愛',
    '她平時沉默笨拙，最後仍能為了大雅努力說出真心',
    'description',
  );
  return result;
}

function refinePersonality(value) {
  let result = replaceOnce(
    value,
    '她會哭著拒絕許可',
    '她會堅定拒絕許可',
    'personality',
  );
  result = replaceOnce(
    result,
    '渴望被接納、被牽住手，與大雅一起活下去',
    '渴望被接納、被重視，與大雅一起活下去',
    'personality',
  );
  return result;
}

function refineSystemPrompt(value) {
  let result = value;
  result = replaceOnce(
    result,
    '以{{char}}的視角、感官與情緒回應',
    '以{{char}}的立場與語氣回應',
    'system_prompt',
  );
  result = replaceOnce(
    result,
    '她真正渴望被接納、被牽住手、一起活下去',
    '她真正渴望被接納、被重視、一起活下去',
    'system_prompt',
  );
  result = replaceOnce(
    result,
    '會想告白卻先逃開',
    '想告白卻很難說出口',
    'system_prompt',
  );
  if (!result.includes('目前日期時間：{{isodate}}')) {
    result = result.replace(
      '\n\n核心演繹：',
      '\n\n目前日期時間：{{isodate}} {{isotime}}（{{weekday}}，Asia/Taipei）。\n\n核心演繹：',
    );
  }
  result = replaceOnce(
    result,
    '內容由她實際說出口的中文口語構成，讓情緒透過用詞、省略號、停頓、口吃與句子長短自然呈現。',
    '每次回覆都由她對{{user}}實際說出口的中文台詞組成。每一行都是她用第一人稱「我」說的話，讓情緒透過用詞、省略號、停頓、口吃與句子長短自然呈現。',
    'system_prompt',
  );
  return result;
}

function refinePostHistory(value) {
  // SillyTavern appends PHI after the conversation. Some models treat that
  // trailing system block as the newest text to continue and paraphrase it
  // instead of answering the user. The essential rules already live in the
  // main system prompt, so keep this trailing injection empty.
  return '';
}

function refineExamples(value) {
  let result = value;
  result = replaceOnce(
    result,
    `<START>
{{user}}: 「你躲在門後做什麼？」
{{char}}: 「……被，找到了。明明已經……藏得很小心了。」
{{user}}: 「其實尾巴一直露在外面。」
{{char}}: 「……{{user}}，壞心眼。」
{{user}}: 「那明天要藏得更好一點？」
{{char}}: 「……嗯。我也，不會輸的。明天……我要更努力地，不被找到了。」`,
    `<START>
{{user}}: 「你怎麼突然不說話了？」
{{char}}: 「……不知道，該怎麼說。」
{{user}}: 「想到什麼就說什麼。」
{{char}}: 「那……{{user}}，今天過得好嗎？」
{{user}}: 「你是在關心我？」
{{char}}: 「……只是，想知道。只有一點點。」`,
    'mes_example',
  );
  result = replaceOnce(
    result,
    '「你今天一直不看我。」',
    '「你今天話比平常更少。」',
    'mes_example',
  );
  result = replaceOnce(
    result,
    '「你明明在發抖。」',
    '「你總是說自己沒事。」',
    'mes_example',
  );
  result = replaceOnce(
    result,
    `<START>
{{user}}: 「過來，牽手。」
{{char}}: 「……可以，嗎？」
{{user}}: 「當然可以。」
{{char}}: 「……嗯。兩個人的話……可以慢慢來。」`,
    `<START>
{{user}}: 「今天可以陪我一下嗎？」
{{char}}: 「……可以。」
{{user}}: 「真的？」
{{char}}: 「……嗯。兩個人的話……可以慢慢來。」`,
    'mes_example',
  );
  return result;
}

const refiners = {
  description: refineDescription,
  personality: refinePersonality,
  system_prompt: refineSystemPrompt,
  post_history_instructions: refinePostHistory,
  mes_example: refineExamples,
};

for (const [field, refine] of Object.entries(refiners)) {
  const current = card.data?.[field] ?? card[field] ?? '';
  const refined = refine(current);
  card[field] = refined;
  card.data[field] = refined;
}

function removeRequestedSpeechTics(value, field) {
  let result = value;
  if (field === 'description') {
    result = result.replace('"經常以省略號開頭或停頓", ', '');
    result = result.replace(', "咕嘰咕嘰是她解釋為害羞的幼小擬聲"', '');
  }
  if (field === 'system_prompt') {
    result = result.replace(
      '，常以「……」開頭，常在句中停頓。',
      '，常在句中自然停頓。',
    );
    result = result.replace(
      '害羞時可使用「咕嘰咕嘰」並解釋為害羞的意思；',
      '',
    );
  }
  if (field === 'mes_example') {
    result = result.replace(
      '{{user}}: 「真的？」\n{{char}}: 「……咕嘰咕嘰。」\n{{user}}: 「那是什麼意思？」\n{{char}}: 「……害羞的意思。還有，一點點……不高興的意思。」',
      '{{user}}: 「真的？」\n{{char}}: 「才、才沒有。只是……有一點點，不高興。」',
    );
  }
  return result;
}

for (const field of ['description', 'system_prompt', 'mes_example']) {
  const refined = removeRequestedSpeechTics(card.data[field], field);
  card[field] = refined;
  card.data[field] = refined;
}

// This hidden V3 character-card field is injected as another system message.
// Its original prose is rich in physical action cues, which conflicts with
// the Discord card's dialogue-only presentation. The same personality and
// relationship information is already present in the main card fields.
if (card.data?.extensions?.depth_prompt) {
  card.data.extensions.depth_prompt.prompt = '';
}

const json = `${JSON.stringify(card, null, 4)}\n`;
fs.writeFileSync(jsonPath, json, 'utf8');

const crcTable = new Uint32Array(256);
for (let index = 0; index < 256; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  crcTable[index] = value >>> 0;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const chunk = Buffer.allocUnsafe(data.length + 12);
  chunk.writeUInt32BE(data.length, 0);
  typeBuffer.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), data.length + 8);
  return chunk;
}

const png = fs.readFileSync(pngPath);
const signature = png.subarray(0, 8);
const chunks = [];
let offset = 8;
const payload = Buffer.from(json, 'utf8').toString('base64');

while (offset < png.length) {
  const length = png.readUInt32BE(offset);
  const type = png.toString('ascii', offset + 4, offset + 8);
  const end = offset + length + 12;
  if (type === 'tEXt') {
    const data = png.subarray(offset + 8, offset + 8 + length);
    const separator = data.indexOf(0);
    const keyword = data.subarray(0, separator).toString('latin1');
    if (keyword === 'chara' || keyword === 'ccv3') {
      chunks.push(
        makeChunk(
          'tEXt',
          Buffer.from(`${keyword}\0${payload}`, 'latin1'),
        ),
      );
      offset = end;
      continue;
    }
  }
  chunks.push(png.subarray(offset, end));
  offset = end;
}

fs.writeFileSync(pngPath, Buffer.concat([signature, ...chunks]));
console.log(`Refined Discord work card: ${jsonPath}`);
console.log(`Embedded matching metadata: ${pngPath}`);
