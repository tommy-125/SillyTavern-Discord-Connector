const RAW_REPLY_TEXT_KEY = 'kurohelperRawReply';
const RAW_REPLY_CACHED_AT_KEY = 'kurohelperRawReplyCachedAt';

export const RAW_REPLY_CACHE_LIMIT = 5;
const recentRawReplies = [];
const cachedMessages = new WeakSet();

function hasCachedRawReply(message) {
  return Boolean(
    message?.extra &&
      Object.prototype.hasOwnProperty.call(message.extra, RAW_REPLY_TEXT_KEY),
  );
}

/**
 * Store a generated reply before output formatting and retain only the most
 * recent entries in the current SillyTavern chat.
 */
export function cacheRawReply(
  chat,
  message,
  rawText,
  {
    limit = RAW_REPLY_CACHE_LIMIT,
    cachedAt = new Date().toISOString(),
  } = {},
) {
  if (!Array.isArray(chat) || !message || typeof message !== 'object') {
    return false;
  }

  const text = String(rawText ?? '');
  if (!text) return false;

  if (!message.extra || typeof message.extra !== 'object') {
    message.extra = {};
  }
  const alreadyCached = hasCachedRawReply(message);
  if (!alreadyCached) {
    message.extra[RAW_REPLY_TEXT_KEY] = text;
    message.extra[RAW_REPLY_CACHED_AT_KEY] = cachedAt;
  }

  if (!cachedMessages.has(message)) {
    cachedMessages.add(message);
    recentRawReplies.push({ cachedAt, rawText: text, source: 'generation' });
    recentRawReplies.splice(0, Math.max(0, recentRawReplies.length - Math.max(1, limit)));
  }

  const legacyCachedMessages = chat.filter(hasCachedRawReply);
  const excess = Math.max(0, legacyCachedMessages.length - Math.max(1, limit));
  for (const staleMessage of legacyCachedMessages.slice(0, excess)) {
    delete staleMessage.extra[RAW_REPLY_TEXT_KEY];
    delete staleMessage.extra[RAW_REPLY_CACHED_AT_KEY];
  }

  return !alreadyCached || excess > 0;
}

export function listRawReplyCache(chat) {
  if (recentRawReplies.length > 0) return recentRawReplies.map((entry) => ({ ...entry }));
  if (!Array.isArray(chat)) return [];
  return chat.filter(hasCachedRawReply).map((message) => ({
    cachedAt: message.extra[RAW_REPLY_CACHED_AT_KEY] || null,
    rawText: message.extra[RAW_REPLY_TEXT_KEY],
    source: 'generation',
  }));
}

export function resetRawReplyCacheForTests() {
  recentRawReplies.length = 0;
}
