const RAW_REPLY_TEXT_KEY = 'kurohelperRawReply';
const RAW_REPLY_CACHED_AT_KEY = 'kurohelperRawReplyCachedAt';
const RAW_REPLY_CHANNEL_ID_KEY = 'kurohelperRawReplyChannelId';
const RAW_REPLY_REQUEST_ID_KEY = 'kurohelperRawReplyRequestId';

export const RAW_REPLY_CACHE_LIMIT = 5;
const recentRawReplies = new Map();
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
    channelId = '',
    requestId = '',
  } = {},
) {
  if (!Array.isArray(chat) || !message || typeof message !== 'object') {
    return false;
  }

  const text = String(rawText ?? '');
  if (!text) return false;
  const normalizedChannelId = String(channelId || '').trim();

  if (!message.extra || typeof message.extra !== 'object') {
    message.extra = {};
  }
  const alreadyCached = hasCachedRawReply(message);
  if (!alreadyCached) {
    message.extra[RAW_REPLY_TEXT_KEY] = text;
    message.extra[RAW_REPLY_CACHED_AT_KEY] = cachedAt;
    message.extra[RAW_REPLY_CHANNEL_ID_KEY] = normalizedChannelId;
    message.extra[RAW_REPLY_REQUEST_ID_KEY] = String(requestId || '').trim();
  }

  if (!cachedMessages.has(message)) {
    cachedMessages.add(message);
    const entries = recentRawReplies.get(normalizedChannelId) || [];
    entries.push({
      cachedAt,
      rawText: text,
      source: 'generation',
      ...(normalizedChannelId ? { channelId: normalizedChannelId } : {}),
      ...(String(requestId || '').trim() ? { requestId: String(requestId).trim() } : {}),
    });
    entries.splice(0, Math.max(0, entries.length - Math.max(1, limit)));
    recentRawReplies.set(normalizedChannelId, entries);
  }

  const legacyCachedMessages = chat.filter((candidate) => hasCachedRawReply(candidate)
    && String(candidate.extra[RAW_REPLY_CHANNEL_ID_KEY] || '') === normalizedChannelId);
  const excess = Math.max(0, legacyCachedMessages.length - Math.max(1, limit));
  for (const staleMessage of legacyCachedMessages.slice(0, excess)) {
    delete staleMessage.extra[RAW_REPLY_TEXT_KEY];
    delete staleMessage.extra[RAW_REPLY_CACHED_AT_KEY];
  }

  return !alreadyCached || excess > 0;
}

export function listRawReplyCache(chat, channelId = '') {
  const normalizedChannelId = String(channelId || '').trim();
  const recent = recentRawReplies.get(normalizedChannelId) || [];
  if (recent.length > 0) return recent.map((entry) => ({ ...entry }));
  if (!Array.isArray(chat)) return [];
  return chat.filter((message) => hasCachedRawReply(message)
    && String(message.extra[RAW_REPLY_CHANNEL_ID_KEY] || '') === normalizedChannelId).map((message) => {
    const requestId = String(message.extra[RAW_REPLY_REQUEST_ID_KEY] || '').trim();
    return {
      cachedAt: message.extra[RAW_REPLY_CACHED_AT_KEY] || null,
      rawText: message.extra[RAW_REPLY_TEXT_KEY],
      source: 'generation',
      ...(normalizedChannelId ? { channelId: normalizedChannelId } : {}),
      ...(requestId ? { requestId } : {}),
    };
  });
}

export function resetRawReplyCacheForTests() {
  recentRawReplies.clear();
}
