/** KuroHelper AI Runtime configuration. Discord credentials belong to kurohelper. */

module.exports = {
  // The built-in KuroHelper transport exposes an authenticated WebSocket API.
  enabledPlugins: ["kurohelper"],

  // SillyTavern browser extension WebSocket port (container-internal).
  wssPort: 2333,

  timezone: "Asia/Taipei",
  locale: "zh-TW",
  userLocale: "zh-TW",
  debug: false,

  // Abort one generation after this limit. A task that ignores abort causes
  // the browser page to reload instead of blocking every channel forever.
  queueTaskTimeoutSeconds: 60,
  imagePlaceholderTimeoutSeconds: 180,
  recentChannelTokenBudget: 500,
  memoryTokenBudget: 400,
  streamResponses: false,
  dialogueOnlyResponses: true,

  // Stable Discord IDs arrive from KuroHelper under the "kurohelper" platform.
  // Display names are used only as the human-readable Persona name.
  autoCreatePersonas: true,
  kurohelperPersonaMap: {},
  kurohelperLanguageMap: {},

  externalPlugins: [],
  plugins: {
    kurohelper: {
      // Set KUROHELPER_BRIDGE_SECRET through .env; do not place it here.
      secret: "",
      circuitBreaker: {
        enabled: true,
        failureThreshold: 5,
        cooldownSeconds: 30,
      },
    },
  },
};
