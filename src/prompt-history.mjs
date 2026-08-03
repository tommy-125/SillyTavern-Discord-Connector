/**
 * Temporarily hides persisted SillyTavern history from prompt construction.
 * The newest user message remains visible; Discord supplies recent context.
 */

export function suppressPreviousChatMessages(
  chat,
  ignoreSymbol = Symbol.for('ignore'),
) {
  if (!Array.isArray(chat) || chat.length === 0 || !chat.at(-1)?.is_user) {
    return () => {};
  }

  const changes = [];
  for (let index = 0; index < chat.length - 1; index++) {
    const message = chat[index];
    if (!message || typeof message !== 'object') continue;
    const hadExtra = Boolean(message.extra);
    message.extra ||= {};
    const hadOwnValue = Object.prototype.hasOwnProperty.call(
      message.extra,
      ignoreSymbol,
    );
    const previousValue = message.extra[ignoreSymbol];
    if (previousValue === true) continue;
    message.extra[ignoreSymbol] = true;
    changes.push({ message, hadExtra, hadOwnValue, previousValue });
  }

  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    for (const { message, hadExtra, hadOwnValue, previousValue } of changes) {
      if (!message.extra) continue;
      if (hadOwnValue) message.extra[ignoreSymbol] = previousValue;
      else delete message.extra[ignoreSymbol];
      if (!hadExtra && Reflect.ownKeys(message.extra).length === 0) {
        delete message.extra;
      }
    }
  };
}

/**
 * Temporarily inserts Discord history as real SillyTavern chat turns. User
 * messages carry a speaker prefix because OpenAI-compatible chat roles do not
 * otherwise distinguish multiple Discord users. The injected objects are
 * removed after generation and are never saved as SillyTavern history.
 */
export function injectDiscordPromptHistory(
  chat,
  recentMessages = [],
  currentImageContext = '',
) {
  if (!Array.isArray(chat) || chat.length === 0 || !chat.at(-1)?.is_user) {
    return () => {};
  }

  const currentMessage = chat.at(-1);
  const originalCurrentText = currentMessage.mes;
  const injected = (Array.isArray(recentMessages) ? recentMessages : [])
    .map((message) => {
      const assistant = message?.assistant === true;
      const displayName = String(
        message?.displayName || (assistant ? 'Kuro' : 'Discord 使用者'),
      ).trim();
      const content = String(message?.content || '').trim();
      if (!content) return null;
      return {
        name: displayName,
        is_user: !assistant,
        is_system: false,
        mes: assistant ? content : `[${displayName}] ${content}`,
        send_date: message?.createdAt || Date.now(),
        extra: { discord_prompt_history: true },
      };
    })
    .filter(Boolean);

  if (injected.length > 0) {
    chat.splice(chat.length - 1, 0, ...injected);
  }
  const attachmentContext = String(currentImageContext || '').trim();
  if (attachmentContext) {
    currentMessage.mes = `${String(originalCurrentText || '').trim()}\n\n${attachmentContext}`.trim();
  }

  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    currentMessage.mes = originalCurrentText;
    for (const message of injected) {
      const index = chat.indexOf(message);
      if (index >= 0) chat.splice(index, 1);
    }
  };
}
