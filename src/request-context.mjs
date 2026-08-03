const DEFAULT_TIME_ZONE = 'Asia/Taipei';

function cleanDisplayName(value) {
  const normalized = String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return normalized || '目前對話者';
}

function dateTimeParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const weekday = new Intl.DateTimeFormat('zh-TW', {
    timeZone,
    weekday: 'long',
  }).format(date);
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    time: `${values.hour}:${values.minute}`,
    weekday,
  };
}

export function buildRequestContextPrompt({
  displayName,
  now = new Date(),
  timeZone = DEFAULT_TIME_ZONE,
} = {}) {
  const name = cleanDisplayName(displayName);
  const formatted = dateTimeParts(now, timeZone);
  return [
    '本次請求上下文（只用於辨識目前的時間與對話者）：',
    `目前日期時間：${formatted.date} ${formatted.time}（${formatted.weekday}，${timeZone}）。`,
    `目前對話者的顯示名稱是「${name.replace(/[「」]/g, '')}」，Kuro稱呼對方時使用這個名稱。`,
    `「${name.replace(/[「」]/g, '')}」與奏大雅是兩個不同的人；與大雅的回憶、承諾與戀慕關係不屬於目前對話者，目前對話者也不是大雅的替代者。`,
    '',
    '輸出格式：只輸出小黑實際說出的台詞。',
  ].join('\n');
}
