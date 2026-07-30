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
