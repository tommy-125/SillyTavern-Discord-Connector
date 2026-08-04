/**
 * websocket.js - SillyTavern Connector: WebSocket Server
 * Copyright (c) 2026 Senjin the Dragon.
 * https://github.com/senjinthedragon/SillyTavern-Discord-Connector
 * Licensed under the MIT License.
 * See /server/LICENSE for full license information.
 *
 * Hosts the SillyTavern extension WebSocket endpoint and fans outbound packets
 * to any enabled frontend plugins using frontend-manager.js.
 */

'use strict';

const WebSocket = require('ws');
const { log } = require('./logger');
const { config, wssPort } = require('./config-loader');
const { rememberTurn, recallMemories } = require('./memory-client');
const { claimProviderMetrics } = require('./metrics-client');
const {
  describeImages,
  getVisionCacheStats,
  VISION_FAILURE_REPLY,
  visionRequestFailed,
} = require('./vision-client');
const { createPluginLoader } = require('./plugin-loader');
const {
  fanout,
  addRoute,
  resolveConversationId,
  getRoutes,
  getFrontend,
  parseRoute,
  getRegisteredPlatforms,
} = require('./frontend-manager');
const { handleBridgePacket } = require('./websocket-router');
const { createWorkerPool } = require('./worker-pool');
const {
  listRuntimeRawResponses,
  mergeRawResponseEntries,
} = require('./raw-response-cache');
const { loadLocale, makeTranslator } = require('./i18n');
const {
  load: loadPersonaMap,
  getPersonaForUser,
  ensurePersonaForUser,
  setPersonaForUser,
  setDefaultPersonaName,
  getDefaultPersonaName,
  setCrossRelayEnabled,
  isCrossRelayEnabled,
} = require('./persona-map');
const {
  load: loadLangMap,
  getLangForUser,
  setLangForUser,
} = require('./lang-map');
const { AVAILABLE_LANGUAGES, findLanguage } = require('./locales-manifest');

const version = require('./package.json').version;
const width = 70;

const canColor = process.stdout.isTTY && process.env.TERM !== 'dumb';

const purple = canColor ? '[38;5;93m' : '';
const gold = canColor ? '[38;5;220m' : '';
const reset = canColor ? '[0m' : '';

const title = ` KUROHELPER AI RUNTIME - v${version}`;
const credit = ` Developed by Senjin the Dragon https://github.com/senjinthedragon`;
const support = ` Please support my work: https://github.com/sponsors/senjinthedragon`;
const btc = ` Bitcoin: bc1qjsaqw6rjcmhv6ywv2a97wfd4zxnae3ncrn8mf9`;

console.log(`
${purple}╔${'═'.repeat(width)}╗
║${gold}${title.padEnd(width)}${purple}║
║${gold}${credit.padEnd(width)}${purple}║
║${gold}${support.padEnd(width)}${purple}║
║${gold}${btc.padEnd(width)}${purple}║
╚${'═'.repeat(width)}╝${reset}
`);

loadPersonaMap();
loadLangMap();
loadLocale(config.userLocale || null);

const workerPool = createWorkerPool({
  isOpen: (socket) => socket?.readyState === WebSocket.OPEN,
  log,
});
let legacyWorkerSequence = 0;
const pendingAutocompletes = {};
const autocompleteDebouncers = {};
const pendingImageMessages = {};
const cancelledImageRequests = new Set();
const timedOutImageRequests = new Set();
const streamHandled = new Set();
const streamReceived = new Set();
const pendingRawReplyRequests = new Map();

function getSillyTavernClient() {
  return workerPool.firstSocket();
}

function getPendingAutocompletes() {
  return pendingAutocompletes;
}

function getAutocompleteDebouncers() {
  return autocompleteDebouncers;
}

function setBridgeActivity(expression, ownerName) {
  for (const platform of getRegisteredPlatforms()) {
    const frontend = getFrontend(platform);
    frontend?.setActivity?.(expression, ownerName);
  }
}

function sendToSillyTavern(payload) {
  return workerPool.sendToAny(payload);
}

function listRawReplies(requestId) {
  const workerIds = workerPool.workerIds();
  if (workerIds.length === 0) {
    return Promise.reject(new Error('SillyTavern is not connected.'));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const pending = pendingRawReplyRequests.get(requestId);
      pendingRawReplyRequests.delete(requestId);
      if (pending?.entries.length) {
        resolve({
          entries: mergeRawResponseEntries([
            ...pending.entries,
            listRuntimeRawResponses(),
          ]),
        });
      } else {
        const runtimeEntries = listRuntimeRawResponses();
        if (runtimeEntries.length > 0) {
          resolve({ entries: runtimeEntries });
        } else {
          reject(new Error('Timed out while reading raw replies.'));
        }
      }
    }, 5000);
    timer.unref?.();
    pendingRawReplyRequests.set(requestId, {
      resolve,
      reject,
      timer,
      remaining: workerIds.length,
      entries: [],
    });
    workerPool.broadcast({ type: 'raw_replies_request', requestId });
  });
}

function resolveRawReplies(requestId, entries) {
  const pending = pendingRawReplyRequests.get(requestId);
  if (!pending) return;
  if (Array.isArray(entries)) pending.entries.push(entries);
  pending.remaining -= 1;
  if (pending.remaining > 0) return;
  pendingRawReplyRequests.delete(requestId);
  clearTimeout(pending.timer);
  pending.resolve({
    entries: mergeRawResponseEntries([
      ...pending.entries,
      listRuntimeRawResponses(),
    ]),
  });
}

function dispatchCommand(platform, chatId, command, args, userId) {
  const conversationId = resolveConversationId(platform, chatId);
  addRoute(conversationId, platform, chatId);
  const userLocale = getLangForUser(platform, userId) || null;

  if (!workerPool.hasWorkers()) {
    handleOfflineCommand(
      platform,
      chatId,
      conversationId,
      command,
      args,
      userId,
      userLocale,
    );
    return;
  }

  sendToSillyTavern({
    type: 'execute_command',
    command,
    args,
    chatId: conversationId,
    userId,
    platform,
    ...(userLocale ? { userLocale } : {}),
  });
}

async function handleOfflineCommand(
  platform,
  chatId,
  conversationId,
  command,
  args,
  userId,
  userLocale,
) {
  const tl = makeTranslator(userLocale);

  if (command === 'sthelp') {
    const sections = [
      tl('help.title'),
      tl('help.offlineNote'),
      tl('help.offlineInfo'),
      tl('help.memory'),
      tl('help.lang'),
      tl('help.footer'),
    ];
    await fanout(conversationId, 'sendText', sections.join('\n\n'));
    return;
  }

  if (command === 'status') {
    const registeredPlatforms = getRegisteredPlatforms();
    const platformList =
      registeredPlatforms.size > 0
        ? [...registeredPlatforms].join(', ')
        : 'none';
    const lines = [
      tl('status.title'),
      tl('status.connection', { value: tl('status.offline') }),
      tl('status.plugins', { value: platformList }),
      tl('status.stOffline'),
    ];
    await fanout(conversationId, 'sendText', lines.join('\n'));
    return;
  }

  if (command === 'setlang') {
    const input = (args?.[0] || '').trim();
    if (!input || input === 'clear') {
      setLangForUser(platform, userId, null);
      await fanout(conversationId, 'sendText', tl('setlang.reset'));
      return;
    }
    const match = findLanguage(input);
    if (match) {
      setLangForUser(platform, userId, match.code);
      const tAfter = makeTranslator(match.code);
      await fanout(
        conversationId,
        'sendText',
        tAfter('setlang.success', { name: match.nativeName, code: match.code }),
      );
    } else {
      await fanout(
        conversationId,
        'sendText',
        tl('setlang.unknown', { input }),
      );
    }
    return;
  }

  await fanout(conversationId, 'sendText', tl('cmd.stOffline'));
}

const pluginLoader = createPluginLoader({
  async onUserMessage(platform, chatId, text, userId = '', metadata = {}) {
    const conversationId = resolveConversationId(platform, chatId);
    addRoute(conversationId, platform, chatId);
    let mappedPersona = getPersonaForUser(platform, userId);
    if (
      !mappedPersona &&
      (config.autoCreatePersonas === true ||
        config.autoCreateDiscordPersonas === true) &&
      metadata.displayName
    ) {
      mappedPersona = ensurePersonaForUser(
        platform,
        userId,
        metadata.displayName,
      ).personaName;
    }
    const userLocale = getLangForUser(platform, userId) || null;
    if (!workerPool.hasWorkers()) {
      return false;
    }
    const memoryPromise = recallMemories({
      query: [
        metadata.retrievalText,
        `[${metadata.displayName || userId}] ${text}`,
      ]
        .filter(Boolean)
        .join('\n'),
      channelId: conversationId,
      participantIds: [
        userId,
        ...(metadata.mentionedUsers || []).map((user) => user?.id),
        ...(metadata.contextParticipants || []).map((user) => user?.id),
      ].filter(Boolean),
    });
    const visionPromise = describeImages(metadata.images, text);
    const [memory, vision] = await Promise.all([memoryPromise, visionPromise]);
    if (metadata.requestId && Array.isArray(vision.metricRecords)) {
      const frontend = getFrontend(platform);
      if (typeof frontend?.sendMetric === 'function') {
        try {
          await Promise.all(vision.metricRecords.map((metrics, index) =>
            frontend.sendMetric(chatId, {
              requestId: `${metadata.requestId}:vision:${index}`,
              sourceRequestId: metadata.requestId,
              operation: 'vision',
              metrics,
            })));
        } catch (error) {
          log('warn', `[Vision] Could not report usage metrics: ${error.message}`);
        }
      }
    }
    if (visionRequestFailed(metadata.images, vision)) {
      log(
        'warn',
        `[Vision] Request ${metadata.requestId || 'unknown'} could not be described; returning the image failure reply.`,
      );
      const frontend = getFrontend(platform);
      if (!frontend?.sendText) return false;
      await frontend.sendText(chatId, VISION_FAILURE_REPLY, {
        kind: 'ai_reply',
        requestId: metadata.requestId || '',
        final: true,
        metrics: {
          status: 'vision_error',
          usageAvailable: false,
          generationCount: 0,
          memoryRecallMs: memory.elapsedMs || 0,
        },
      });
      return true;
    }
    const recentChannelContext = metadata.recentChannelContext || '';
    const generationPacket = {
      type: 'user_message',
      text,
      chatId: conversationId,
      userId,
      platform,
      requestId: metadata.requestId || '',
      receivedAt: Date.now(),
      displayName: metadata.displayName || '',
      mentionedUsers: metadata.mentionedUsers || [],
      contextParticipants: metadata.contextParticipants || [],
      recentChannelContext,
      recentMessages: Array.isArray(metadata.recentMessages)
        ? metadata.recentMessages
        : [],
      visionContext: vision.context || '',
      visionObservations: Array.isArray(vision.structured) ? vision.structured : [],
      memoryRecentContext: metadata.retrievalText || '',
      memoryContext: memory.context || '',
      memoryRecallMs: memory.elapsedMs || 0,
      visionMs: vision.elapsedMs || 0,
      visionModel: vision.model || '',
      ...(mappedPersona ? { mappedPersona } : {}),
      ...(userLocale ? { userLocale } : {}),
    };
    const accepted = workerPool.enqueue({
      channelId: conversationId,
      requestId: metadata.requestId || '',
      payload: generationPacket,
      onDrop: (error) => {
        log(
          'warn',
          `[Workers] Request ${(metadata.requestId || 'unknown').slice(-8)} failed: ${error.message}`,
        );
        fanout(
          conversationId,
          'sendText',
          '生成工作頁中斷，請再試一次。',
          {
            kind: 'error',
            requestId: metadata.requestId || '',
            final: true,
            metrics: { status: 'worker_disconnected' },
          },
        ).catch((fanoutError) =>
          log('warn', `[Workers] Could not report dropped request: ${fanoutError.message}`),
        );
      },
    });
    if (!accepted) return false;

    // Cross-relay the user's message to all other platforms in the same
    // conversation so every connected client stays in sync.
    if (!isCrossRelayEnabled()) return true;
    const originKey = `${platform}:${chatId}`;
    const senderLabel =
      mappedPersona || getDefaultPersonaName() || `[${platform}]`;
    const relayText = `${senderLabel}: ${text}`;
    for (const route of getRoutes(conversationId)) {
      if (route === originKey) continue;
      const { platform: targetPlatform, nativeChatId: targetChatId } =
        parseRoute(route);
      const frontend = getFrontend(targetPlatform);
      if (!frontend?.sendText) continue;
      frontend.sendText(targetChatId, relayText).catch((err) => {
        log('warn', `[Bridge] Cross-relay to ${route} failed: ${err.message}`);
      });
    }
    return true;
  },
  onCommand(platform, chatId, command, args, userId = '') {
    dispatchCommand(platform, chatId, command, args, userId);
  },
  isSillyTavernReady: () =>
    workerPool.hasWorkers(),
  listRawReplies,
  getVisionCacheStats,
  log,
});

pluginLoader.start().catch((err) => {
  log('error', `[Plugins] Failed to start plugin: ${err.message}`);
});

const wss = new WebSocket.Server({
  port: wssPort,
  maxPayload: 50 * 1024 * 1024,
});
log('log', `[Bridge] WebSocket server listening on port ${wssPort}`);

function workerIdFromRequest(request) {
  try {
    const value = new URL(request?.url || '/', 'ws://localhost').searchParams
      .get('workerId');
    const normalized = String(value || '')
      .trim()
      .replace(/[^a-zA-Z0-9_.-]/g, '-')
      .slice(0, 64);
    if (normalized) return normalized;
  } catch {}
  legacyWorkerSequence += 1;
  return `legacy-${legacyWorkerSequence}`;
}

wss.on('connection', (ws, request) => {
  const workerId = workerIdFromRequest(request);
  let messageTail = Promise.resolve();

  // Build plugin status map for all known platforms. Only platforms that
  // successfully registered via registerFrontend() are marked "active".
  // Others show as "not_loaded" so the extension can tease pro platforms
  // to free version users.
  const KNOWN_PLATFORMS = ['kurohelper'];
  const registeredPlatforms = getRegisteredPlatforms();
  const pluginStatus = Object.fromEntries(
    KNOWN_PLATFORMS.map((p) => [
      p,
      registeredPlatforms.has(p) ? 'active' : 'not_loaded',
    ]),
  );

  ws.send(
    JSON.stringify({
      type: 'bridge_config',
      workerId,
      workerPool: workerPool.snapshot(),
      timezone: config.timezone || null,
      locale: config.locale || null,
      userLocale: config.userLocale || null,
      availableLanguages: AVAILABLE_LANGUAGES,
      plugins: pluginStatus,
      imagePlaceholderTimeoutMs: config.imagePlaceholderTimeoutMs,
      generationTimeoutMs: config.queueTaskTimeoutMs,
      dynamicContextTokenBudget: config.dynamicContextTokenBudget,
      memorySoftTokenBudget: config.memorySoftTokenBudget,
      streamResponses: config.streamResponses === true,
      dialogueOnlyResponses: config.dialogueOnlyResponses === true,
    }),
  );
  workerPool.register(workerId, ws);

  async function processWorkerMessage(message) {
    let data;
    try {
      data = JSON.parse(
        typeof message === 'string' ? message : message.toString('utf8'),
      );
    } catch (err) {
      log('warn', `[Bridge] Dropping invalid JSON packet from ${workerId}: ${err.message}`);
      return;
    }

    await handleBridgePacket(data, {
      ws,
      fanout,
      getRoutes,
      getFrontend,
      parseRoute,
      streamHandled,
      streamReceived,
      pendingImageMessages,
      cancelledImageRequests,
      timedOutImageRequests,
      setBridgeActivity,
      getPendingAutocompletes,
      setPersonaForUser,
      setLangForUser,
      setCurrentPersonaName: setDefaultPersonaName,
      setCrossRelayEnabled,
      rememberTurn,
      claimProviderMetrics: (since) => claimProviderMetrics(since, workerId),
      resolveRawReplies,
      log,
    });

    if (data.type === 'generation_complete') {
      if (!workerPool.complete(workerId, data.requestId)) {
        log(
          'warn',
          `[Workers] Ignored unmatched completion ${(data.requestId || 'unknown').slice(-8)} from ${workerId}.`,
        );
      }
    }
    if (data.type === 'worker_draining') {
      workerPool.abandon(workerId, data.requestId);
    }
  }

  ws.on('message', (message) => {
    messageTail = messageTail
      .then(() => processWorkerMessage(message))
      .catch((error) =>
        log('warn', `[Bridge] Packet from ${workerId} failed: ${error.message}`),
      );
  });

  ws.on('close', () => {
    messageTail.finally(() => {
      workerPool.unregister(workerId, ws);
      if (workerPool.hasWorkers()) return;

      setBridgeActivity(null);
      streamHandled.clear();
      streamReceived.clear();

      for (const key of Object.keys(pendingImageMessages)) {
        delete pendingImageMessages[key];
      }
      cancelledImageRequests.clear();
      timedOutImageRequests.clear();

      for (const pending of pendingRawReplyRequests.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('SillyTavern disconnected.'));
      }
      pendingRawReplyRequests.clear();

      const autocompleteDebouncers = getAutocompleteDebouncers();
      for (const [key, debouncer] of Object.entries(autocompleteDebouncers)) {
        clearTimeout(debouncer.timer);
        delete autocompleteDebouncers[key];
        debouncer.interaction.respond([]).catch(() => {});
      }

      const pendingAutocompletes = getPendingAutocompletes();
      for (const [requestId, pending] of Object.entries(pendingAutocompletes)) {
        clearTimeout(pending.timeout);
        delete pendingAutocompletes[requestId];
        pending.interaction.respond([]).catch(() => {});
      }
    });
  });
});

module.exports = { getSillyTavernClient, dispatchCommand, workerPool };
