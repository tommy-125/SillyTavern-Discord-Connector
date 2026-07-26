'use strict';

/**
 * Decide whether an incoming Discord message should be forwarded. Keep the
 * configured textual prefix in the prompt so SillyTavern can see the character
 * name the user addressed; only Discord's machine-readable mention is removed.
 *
 * @param {object} options
 * @param {string} options.content Raw Discord message content.
 * @param {string|undefined} options.triggerPrefix Configured trigger prefix.
 * @param {string|null} options.botUserId The connected Discord bot user ID.
 * @param {boolean} options.isBotMentioned Whether Discord parsed a bot mention.
 * @returns {{accepted: boolean, content: string}}
 */
function prepareIncomingContent({
  content,
  triggerPrefix,
  botUserId,
  isBotMentioned,
}) {
  let nextContent = String(content || '');
  const hasPrefix = Boolean(
    triggerPrefix && nextContent.startsWith(triggerPrefix),
  );

  if (triggerPrefix && !hasPrefix && !isBotMentioned) {
    return { accepted: false, content: nextContent };
  }

  if (isBotMentioned && botUserId) {
    const escapedId = botUserId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    nextContent = nextContent
      .replace(new RegExp(`<@!?${escapedId}>`, 'g'), ' ')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
  }

  return { accepted: true, content: nextContent };
}

module.exports = { prepareIncomingContent };
