const RAW_REPLY_TEXT_KEY = 'kurohelperRawReply';
const RAW_REPLY_CACHED_AT_KEY = 'kurohelperRawReplyCachedAt';

export const RAW_REPLY_CACHE_LIMIT = 5;

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

  const cachedMessages = chat.filter(hasCachedRawReply);
  const excess = Math.max(0, cachedMessages.length - Math.max(1, limit));
  for (const staleMessage of cachedMessages.slice(0, excess)) {
    delete staleMessage.extra[RAW_REPLY_TEXT_KEY];
    delete staleMessage.extra[RAW_REPLY_CACHED_AT_KEY];
  }

  return !alreadyCached || excess > 0;
}

export function listRawReplyCache(chat) {
  if (!Array.isArray(chat)) return [];
  return chat.filter(hasCachedRawReply).map((message) => ({
    cachedAt: message.extra[RAW_REPLY_CACHED_AT_KEY] || null,
    rawText: message.extra[RAW_REPLY_TEXT_KEY],
  }));
}
