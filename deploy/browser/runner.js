"use strict";

const { createHash } = require("node:crypto");
const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require("playwright");

const ST_URL = process.env.SILLYTAVERN_URL || "http://sillytavern:8000";
const BRIDGE_URL =
  process.env.CONNECTOR_BRIDGE_URL || "ws://ai-runtime:2333";
const PROFILE_DIR = process.env.BROWSER_PROFILE_DIR || "/data/profile";
const UI_TIMEOUT_MS = positiveInt(
  process.env.CONNECTOR_UI_TIMEOUT_MS,
  120_000,
);
const WATCH_INTERVAL_MS = positiveInt(
  process.env.CONNECTOR_WATCH_INTERVAL_MS,
  15_000,
);
const UI_READY_ATTEMPT_MS = positiveInt(
  process.env.CONNECTOR_UI_READY_ATTEMPT_MS,
  20_000,
);
const HEALTH_PORT = positiveInt(process.env.BROWSER_HEALTH_PORT, 8082);
const WORKER_COUNT = Math.min(positiveInt(process.env.ST_WORKER_COUNT, 1), 8);
const HEALTH_STALE_MS = Math.max(WATCH_INTERVAL_MS * 3, 45_000);
const UI_READY_ATTEMPTS = 3;
const SESSION_FAILURE_LIMIT = 3;
const BASIC_AUTH_USERNAME = process.env.ST_BASIC_AUTH_USERNAME || "";
const BASIC_AUTH_PASSWORD = process.env.ST_BASIC_AUTH_PASSWORD || "";
const OPENROUTER_MODEL = (process.env.OPENROUTER_MODEL || "").trim();
const OPENROUTER_PROXY_URL = (process.env.OPENROUTER_PROXY_URL || "").trim();
const OPENROUTER_REASONING_EFFORT = (
  process.env.OPENROUTER_REASONING_EFFORT || "auto"
)
  .trim()
  .toLowerCase();
const OPENROUTER_SHOW_THOUGHTS = booleanFlag(
  process.env.OPENROUTER_SHOW_THOUGHTS,
  false,
  "OPENROUTER_SHOW_THOUGHTS",
);
const DEFAULT_CHARACTER = (process.env.ST_DEFAULT_CHARACTER || "").trim();
const DEFAULT_PERSONA = (process.env.ST_DEFAULT_PERSONA || "User").trim();
const UI_LANGUAGE = (process.env.ST_UI_LANGUAGE || "en").trim();
const PROMPT_SNAPSHOT_PATH = (
  process.env.CONNECTOR_PROMPT_SNAPSHOT_PATH || ""
).trim();
const PROMPT_SNAPSHOT_TEST_MESSAGE = (
  process.env.CONNECTOR_PROMPT_SNAPSHOT_TEST_MESSAGE || ""
).trim();
const PROMPT_SNAPSHOT_DISPLAY_NAME = (
  process.env.CONNECTOR_PROMPT_SNAPSHOT_DISPLAY_NAME || DEFAULT_PERSONA
).trim();
const PROMPT_SNAPSHOT_RECENT_CONTEXT = (
  process.env.CONNECTOR_PROMPT_SNAPSHOT_RECENT_CONTEXT || ""
).trim();
const PROMPT_SNAPSHOT_VISION_CONTEXT = (
  process.env.CONNECTOR_PROMPT_SNAPSHOT_VISION_CONTEXT || ""
).trim();
const PROMPT_SNAPSHOT_MEMORY_CONTEXT = (
  process.env.CONNECTOR_PROMPT_SNAPSHOT_MEMORY_CONTEXT || ""
).trim();
const OPENROUTER_KEY_MARKER = path.join(
  PROFILE_DIR,
  ".openrouter-key.sha256",
);

let shuttingDown = false;
const activeContexts = new Map();
let openRouterApiKey = "";
let healthServer = null;
const consecutiveSessionFailures = new Map();
const workerHealth = new Map(
  Array.from({ length: WORKER_COUNT }, (_, index) => [
    `worker-${index + 1}`,
    {
      uiReady: false,
      providerReady: false,
      bridgeConnected: false,
      lastProbeAt: 0,
      lastError: "starting",
      sessionStartedAt: 0,
    },
  ]),
);

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function log(level, message) {
  const timestamp = new Date().toISOString();
  console.log(`${timestamp} [browser-worker] [${level}] ${message}`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function setHealth(workerId, patch) {
  const state = workerHealth.get(workerId);
  if (state) Object.assign(state, patch);
}

function healthSnapshot() {
  const workers = [...workerHealth.entries()].map(([id, state]) => {
    const probeAgeMs = state.lastProbeAt
      ? Date.now() - state.lastProbeAt
      : null;
    const healthy = Boolean(
      state.uiReady &&
        state.providerReady &&
        state.bridgeConnected &&
        probeAgeMs != null &&
        probeAgeMs <= HEALTH_STALE_MS,
    );
    return { id, ...state, probeAgeMs, healthy };
  });
  const healthy = workers.length === WORKER_COUNT && workers.every((worker) => worker.healthy);
  return {
    status: healthy ? "ok" : "unhealthy",
    healthy,
    model: OPENROUTER_MODEL,
    configuredWorkers: WORKER_COUNT,
    readyWorkers: workers.filter((worker) => worker.healthy).length,
    uiReady: workers.every((worker) => worker.uiReady),
    providerReady: workers.every((worker) => worker.providerReady),
    bridgeConnected: workers.every((worker) => worker.bridgeConnected),
    lastError: workers.find((worker) => worker.lastError)?.lastError || null,
    workers,
  };
}

function startHealthServer() {
  const server = http.createServer((request, response) => {
    if (request.method !== "GET" || request.url !== "/health") {
      response.writeHead(404).end();
      return;
    }
    const snapshot = healthSnapshot();
    const body = JSON.stringify(snapshot);
    response.writeHead(snapshot.healthy ? 200 : 503, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body),
    });
    response.end(body);
  });
  server.listen(HEALTH_PORT, "0.0.0.0", () => {
    log("info", `Health endpoint listening on 0.0.0.0:${HEALTH_PORT}`);
  });
  return server;
}

async function readOptionalFile(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

async function loadConfiguration() {
  if (!OPENROUTER_MODEL) {
    throw new Error("OPENROUTER_MODEL is required; set it in .env");
  }

  openRouterApiKey = (process.env.OPENROUTER_API_KEY || "").trim();
  if (!openRouterApiKey) {
    throw new Error("OPENROUTER_API_KEY is required; set it in .env");
  }

  if (
    !["none", "auto", "min", "low", "medium", "high", "max"].includes(
      OPENROUTER_REASONING_EFFORT,
    )
  ) {
    throw new Error(
      "OPENROUTER_REASONING_EFFORT must be none, auto, min, low, medium, high, or max",
    );
  }
}

function booleanFlag(value, fallback, name) {
  if (value == null || String(value).trim() === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`${name} must be true or false`);
}

async function configureOpenRouter(page, workerId) {
  await page.waitForSelector("#main_api", {
    state: "attached",
    timeout: UI_TIMEOUT_MS,
  });
  await page.waitForSelector("#chat_completion_source", {
    state: "attached",
    timeout: UI_TIMEOUT_MS,
  });

  const workerProxyUrl = OPENROUTER_PROXY_URL
    ? `${OPENROUTER_PROXY_URL.replace(/\/v1\/?$/, "").replace(/\/+$/, "")}/worker/${encodeURIComponent(workerId)}/v1`
    : "";
  const providerSource = workerProxyUrl ? "custom" : "openrouter";
  const secretKey = OPENROUTER_PROXY_URL
    ? "api_key_custom"
    : "api_key_openrouter";
  const keyHash = createHash("sha256")
    .update(`${providerSource}\0${openRouterApiKey}`)
    .digest("hex");
  const previousKeyHash = (await readOptionalFile(OPENROUTER_KEY_MARKER)).trim();

  const wroteSecret = await page.evaluate(
    async ({ apiKey, shouldReplaceSecret, providerSource, secretKey, proxyUrl, model }) => {
      const secrets = await import("/scripts/secrets.js");
      const secretExists = Boolean(secrets.secret_state?.[secretKey]);

      if (shouldReplaceSecret || !secretExists) {
        const id = await secrets.writeSecret(
          secretKey,
          apiKey,
          "Docker AI provider key",
        );
        if (!id) throw new Error("SillyTavern rejected the OpenRouter API key");
      }

      const mainApi = document.querySelector("#main_api");
      const source = document.querySelector("#chat_completion_source");
      if (!(mainApi instanceof HTMLSelectElement)) {
        throw new Error("SillyTavern main API selector is unavailable");
      }
      if (!(source instanceof HTMLSelectElement)) {
        throw new Error("SillyTavern chat completion selector is unavailable");
      }

      if (mainApi.value !== "openai") {
        globalThis.jQuery(mainApi).val("openai").trigger("change");
      }
      if (source.value !== providerSource) {
        globalThis.jQuery(source).val(providerSource).trigger("change");
      }
      if (providerSource === "custom") {
        const urlInput = document.querySelector("#custom_api_url_text");
        const modelInput = document.querySelector("#custom_model_id");
        if (!(urlInput instanceof HTMLInputElement)) {
          throw new Error("SillyTavern custom API URL field is unavailable");
        }
        if (!(modelInput instanceof HTMLInputElement)) {
          throw new Error("SillyTavern custom model field is unavailable");
        }
        globalThis.jQuery(urlInput).val(proxyUrl).trigger("input");
        globalThis.jQuery(modelInput).val(model).trigger("input");
      }

      return shouldReplaceSecret || !secretExists;
    },
    {
      apiKey: openRouterApiKey,
      shouldReplaceSecret: previousKeyHash !== keyHash,
      providerSource,
      secretKey,
      proxyUrl: workerProxyUrl,
      model: OPENROUTER_MODEL,
    },
  );

  if (wroteSecret) {
    await fs.mkdir(PROFILE_DIR, { recursive: true });
    await fs.writeFile(OPENROUTER_KEY_MARKER, `${keyHash}\n`, {
      mode: 0o600,
    });
  }

  if (providerSource === "openrouter") try {
    await page.waitForFunction(
      (model) =>
        Array.from(
          document.querySelectorAll("#model_openrouter_select option"),
        ).some((option) => option.value === model),
      OPENROUTER_MODEL,
      { timeout: Math.min(UI_TIMEOUT_MS, 30_000) },
    );
  } catch {
    log("info", "Requesting the OpenRouter model list from SillyTavern");
    await page.evaluate(() => {
      const button = document.querySelector("#api_button_openai");
      if (!(button instanceof HTMLElement)) {
        throw new Error("SillyTavern OpenAI-compatible connect button is unavailable");
      }
      button.click();
    });
    await page.waitForFunction(
      (model) =>
        Array.from(
          document.querySelectorAll("#model_openrouter_select option"),
        ).some((option) => option.value === model),
      OPENROUTER_MODEL,
      { timeout: UI_TIMEOUT_MS },
    );
  }

  await page.evaluate(({ model, providerSource }) => {
    const selector = providerSource === "custom"
      ? "#model_custom_select"
      : "#model_openrouter_select";
    const select = document.querySelector(selector);
    if (providerSource === "custom" && !(select instanceof HTMLSelectElement)) {
      return;
    }
    if (!(select instanceof HTMLSelectElement)) {
      throw new Error("SillyTavern OpenRouter model selector is unavailable");
    }
    if (Array.from(select.options).some((option) => option.value === model)) {
      globalThis.jQuery(select).val(model).trigger("change");
    }
  }, { model: OPENROUTER_MODEL, providerSource });

  // SillyTavern maps "auto" to an omitted reasoning effort, which lets the
  // selected model use its own default. Other values remain explicit overrides.
  await page.evaluate(({ reasoningEffort, showThoughts }) => {
    const thoughts = document.querySelector("#openai_show_thoughts");
    const effort = document.querySelector("#openai_reasoning_effort");
    if (!(thoughts instanceof HTMLInputElement)) {
      throw new Error("SillyTavern reasoning toggle is unavailable");
    }
    if (!(effort instanceof HTMLSelectElement)) {
      throw new Error("SillyTavern reasoning effort selector is unavailable");
    }

    const disabled = reasoningEffort === "none";
    const uiEffort = disabled ? "min" : reasoningEffort;
    const shouldShowThoughts = showThoughts && !disabled;
    if (thoughts.checked !== shouldShowThoughts) {
      globalThis.jQuery(thoughts)
        .prop("checked", shouldShowThoughts)
        .trigger("input");
    }
    if (effort.value !== uiEffort) {
      globalThis.jQuery(effort).val(uiEffort).trigger("input");
    }
  }, {
    reasoningEffort: OPENROUTER_REASONING_EFFORT,
    showThoughts: OPENROUTER_SHOW_THOUGHTS,
  });

  await page.waitForFunction(
    () => {
      const button = document.querySelector("#api_button_openai");
      return Boolean(button && !button.classList.contains("disabled"));
    },
    undefined,
    { timeout: UI_TIMEOUT_MS },
  );
  await page.evaluate(() => {
    document.querySelector("#api_button_openai").click();
  });
  await page.waitForFunction(
    () => {
      const button = document.querySelector("#api_button_openai");
      return Boolean(button && !button.classList.contains("disabled"));
    },
    undefined,
    { timeout: UI_TIMEOUT_MS },
  );
  const statusDeadline = Date.now() + UI_TIMEOUT_MS;
  let onlineStatus = "no_connection";
  while (onlineStatus === "no_connection" && Date.now() < statusDeadline) {
    onlineStatus = await page.evaluate(
      async () => (await import("/script.js")).online_status,
    );
    if (onlineStatus === "no_connection") await delay(500);
  }
  if (onlineStatus === "no_connection") {
    throw new Error("SillyTavern did not connect to the AI provider in time");
  }

  log(
    "info",
    `OpenRouter is ready with model ${OPENROUTER_MODEL}; reasoning ${OPENROUTER_REASONING_EFFORT}; thoughts ${OPENROUTER_SHOW_THOUGHTS ? "on" : "off"}; metrics ${workerProxyUrl ? `enabled (${workerId})` : "disabled"}`,
  );
}

async function selectDefaultCharacter(page) {
  if (!DEFAULT_CHARACTER) return;

  const deadline = Date.now() + UI_TIMEOUT_MS;
  let selected = false;
  while (!selected && Date.now() < deadline) {
    selected = await page.evaluate(async (name) => {
      const sillyTavern = await import("/script.js");
      const index = sillyTavern.characters.findIndex(
        (character) =>
          character.name.localeCompare(name, undefined, {
            sensitivity: "accent",
          }) === 0,
      );
      if (index < 0) return false;
      await sillyTavern.selectCharacterById(index, { switchMenu: false });
      return true;
    }, DEFAULT_CHARACTER);
    if (!selected) await delay(500);
  }

  if (!selected) {
    throw new Error(`Character not found: ${DEFAULT_CHARACTER}`);
  }

  log("info", `Selected SillyTavern character ${DEFAULT_CHARACTER}`);
}

async function selectWorkerChat(page, workerId) {
  if (!DEFAULT_CHARACTER) return;
  const chatName = `KuroHelper ${workerId}`;
  const selectedChat = await page.evaluate(async (name) => {
    const sillyTavern = await import("/script.js");
    if (sillyTavern.getCurrentChatId() !== name) {
      // openCharacterChat() persists characters[this_chid].chat back into the
      // shared character card. Multiple browser workers calling it at once can
      // therefore replace one another's target chat while retaining a different
      // chat's integrity slug. Keep the worker chat selection page-local.
      await sillyTavern.clearChat({ clearData: true });
      const character = sillyTavern.characters[sillyTavern.this_chid];
      if (!character) throw new Error("No active character for worker chat");
      character.chat = name;
      await sillyTavern.getChat();
    }
    return sillyTavern.getCurrentChatId();
  }, chatName);
  if (selectedChat !== chatName) {
    throw new Error(
      `${workerId} selected unexpected chat ${selectedChat || "(none)"}`,
    );
  }
  log("info", `${workerId} selected isolated chat ${chatName}`);
}

function bridgeUrlForWorker(workerId) {
  const url = new URL(BRIDGE_URL);
  url.searchParams.set("workerId", workerId);
  return url.toString();
}

async function completeOnboarding(page, timeout = UI_TIMEOUT_MS) {
  await page.waitForFunction(
    () => {
      const onboarding = document.querySelector("dialog.popup[open] .onboarding");
      const loader = document.querySelector("#loader");
      const mainApi = document.querySelector("#main_api");
      return Boolean(
        onboarding ||
          mainApi ||
          (loader && getComputedStyle(loader).display === "none"),
      );
    },
    undefined,
    { timeout },
  );

  const onboarding = page.locator("dialog.popup[open] .onboarding");
  if (!(await onboarding.count())) return;

  const popup = onboarding.locator("xpath=ancestor::dialog");
  await popup.locator(".popup-input").fill(DEFAULT_PERSONA || "User");
  await popup.locator(".popup-button-ok").click();
  await onboarding.waitFor({ state: "hidden", timeout });

  log("info", `Completed SillyTavern onboarding as ${DEFAULT_PERSONA || "User"}`);
}

async function connectorIsConnected(page) {
  return page.evaluate(() => {
    const status = document.querySelector("#discord_connection_status");
    return Boolean(status && status.style.color === "green");
  });
}

async function providerIsConnected(page) {
  return page.evaluate(
    async () => (await import("/script.js")).online_status !== "no_connection",
  );
}

async function connectExtension(page, bridgeUrl) {
  await page.waitForSelector("#discord_bridge_url", {
    state: "attached",
    timeout: UI_TIMEOUT_MS,
  });

  if (await connectorIsConnected(page)) {
    log("info", `Connector is connected to ${bridgeUrl}`);
    return;
  }

  await page.evaluate(() => {
    const connect = document.querySelector("#discord_connect_button");
    if (!(connect instanceof HTMLInputElement)) {
      throw new Error("KuroHelper AI Runtime connect button is unavailable");
    }
    connect.click();
  });

  await page.waitForFunction(
    () => {
      const status = document.querySelector("#discord_connection_status");
      return Boolean(status && status.style.color === "green");
    },
    undefined,
    { timeout: UI_TIMEOUT_MS },
  );

  log("info", `Connector is connected to ${bridgeUrl}`);
}

async function capturePromptSnapshot(page) {
  if (!PROMPT_SNAPSHOT_PATH) return;

  const snapshot = await page.evaluate(async (input) => {
    const sillyTavern = await import("/script.js");
    const { buildRequestContextPrompt } = await import(
      "/scripts/extensions/third-party/KuroHelper-AI-Runtime/src/request-context.mjs"
    );
    const { buildBudgetedDynamicHistory } = await import(
      "/scripts/extensions/third-party/KuroHelper-AI-Runtime/src/prompt-budget.mjs"
    );
    const {
      injectDiscordPromptHistory,
      suppressPreviousChatMessages,
    } = await import(
      "/scripts/extensions/third-party/KuroHelper-AI-Runtime/src/prompt-history.mjs"
    );
    const promptKeys = {
      request: "discord_connector_request_context",
      recent: "discord_connector_recent_channel_context",
      vision: "discord_connector_vision_context",
      memory: "discord_connector_long_term_memory",
    };
    const promptOptions = [
      sillyTavern.extension_prompt_types.IN_CHAT,
      1,
      false,
      sillyTavern.extension_prompt_roles.SYSTEM,
    ];
    const insertedTestMessage = Boolean(input.testMessage);
    if (insertedTestMessage) {
      sillyTavern.chat.push({
        name: input.displayName || sillyTavern.name1 || "User",
        is_user: true,
        is_system: false,
        send_date: new Date().toISOString(),
        mes: input.testMessage,
        extra: { prompt_snapshot_only: true },
      });
    }

    const restoreHistory = suppressPreviousChatMessages(
      sillyTavern.chat,
      sillyTavern.symbols?.ignore ?? Symbol.for("ignore"),
    );
    const recentMessages = String(input.recentChannelContext || "")
      .split(/\r?\n/)
      .map((line, index) => {
        const match = line.trim().match(/^\[([^\]]+)\]\s*(.+)$/);
        if (!match) return null;
        if (
          match[1] === "Kuro"
          && match[2] === "已開始新的短期對話；長期記憶不會被刪除。"
        ) return null;
        return {
          id: `snapshot-${index}`,
          displayName: match[1],
          content: match[2],
          assistant: match[1] === "Kuro",
        };
      })
      .filter(Boolean);
    const dynamicContexts = buildBudgetedDynamicHistory({
      recentMessages,
      visionContext: input.visionContext,
      memoryContext: input.memoryContext,
      dynamicContextTokenBudget: input.dynamicContextTokenBudget,
      memorySoftTokenBudget: input.memorySoftTokenBudget,
    });
    const restoreDiscordHistory = injectDiscordPromptHistory(
      sillyTavern.chat,
      dynamicContexts.recentMessages,
      dynamicContexts.currentImageContext,
    );
    sillyTavern.setExtensionPrompt(
      promptKeys.request,
      buildRequestContextPrompt({ displayName: input.displayName }),
      ...promptOptions,
    );
    sillyTavern.setExtensionPrompt(
      promptKeys.memory,
      dynamicContexts.memoryContext,
      ...promptOptions,
    );

    const captured = new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Prompt dry-run event timed out")),
        30_000,
      );
      const handler = (event) => {
        if (!event?.dryRun) return;
        clearTimeout(timeout);
        sillyTavern.eventSource.removeListener(
          sillyTavern.event_types.CHAT_COMPLETION_PROMPT_READY,
          handler,
        );
        resolve(event.chat);
      };
      sillyTavern.eventSource.on(
        sillyTavern.event_types.CHAT_COMPLETION_PROMPT_READY,
        handler,
      );
    });

    try {
      await sillyTavern.Generate("normal", {}, true);
      return await captured;
    } finally {
      restoreDiscordHistory();
      restoreHistory();
      for (const key of Object.values(promptKeys)) {
        sillyTavern.setExtensionPrompt(key, "", ...promptOptions);
      }
      if (insertedTestMessage) sillyTavern.chat.pop();
    }
  }, {
    testMessage: PROMPT_SNAPSHOT_TEST_MESSAGE,
    displayName: PROMPT_SNAPSHOT_DISPLAY_NAME,
    recentChannelContext: PROMPT_SNAPSHOT_RECENT_CONTEXT,
    visionContext: PROMPT_SNAPSHOT_VISION_CONTEXT,
    memoryContext: PROMPT_SNAPSHOT_MEMORY_CONTEXT,
    dynamicContextTokenBudget: 1200,
    memorySoftTokenBudget: 400,
  });

  await fs.mkdir(path.dirname(PROMPT_SNAPSHOT_PATH), { recursive: true });
  await fs.writeFile(
    PROMPT_SNAPSHOT_PATH,
    `${JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        source: "SillyTavern Generate(normal, {}, true)",
        testMessage: PROMPT_SNAPSHOT_TEST_MESSAGE || null,
        displayName: PROMPT_SNAPSHOT_DISPLAY_NAME || null,
        recentChannelContext: PROMPT_SNAPSHOT_RECENT_CONTEXT || null,
        visionContext: PROMPT_SNAPSHOT_VISION_CONTEXT || null,
        memoryContext: PROMPT_SNAPSHOT_MEMORY_CONTEXT || null,
        messages: snapshot,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  log("info", `Captured dry-run prompt snapshot at ${PROMPT_SNAPSHOT_PATH}`);
}

async function openSillyTavern(page, workerId, bridgeUrl) {
  setHealth(workerId, {
    uiReady: false,
    providerReady: false,
    bridgeConnected: false,
    lastProbeAt: 0,
  });

  let uiError = null;
  for (let attempt = 1; attempt <= UI_READY_ATTEMPTS; attempt += 1) {
    try {
      log("info", `Opening ${ST_URL} (UI attempt ${attempt}/${UI_READY_ATTEMPTS})`);
      await page.goto(ST_URL, {
        // A restored profile can leave extension initialization pending. Use a
        // bounded attempt so a stale page is reloaded instead of blocking the
        // worker for the full provider timeout.
        waitUntil: "commit",
        timeout: UI_READY_ATTEMPT_MS,
      });
      log("info", "SillyTavern navigation committed; waiting for the UI");
      await completeOnboarding(page, UI_READY_ATTEMPT_MS);
      // This control is injected by the connector extension only after the
      // SillyTavern application and extension settings have initialized.
      await page.waitForSelector("#discord_bridge_url", {
        state: "attached",
        timeout: UI_READY_ATTEMPT_MS,
      });
      setHealth(workerId, { uiReady: true, lastError: "" });
      uiError = null;
      break;
    } catch (error) {
      uiError = error;
      setHealth(workerId, { lastError: `UI readiness failed: ${error.message}` });
      log(
        "warn",
        `SillyTavern UI attempt ${attempt}/${UI_READY_ATTEMPTS} failed: ${error.message}`,
      );
      if (attempt < UI_READY_ATTEMPTS) {
        await page
          .goto("about:blank", { waitUntil: "commit", timeout: 5_000 })
          .catch(() => {});
        await delay(3_000);
      }
    }
  }

  if (uiError) {
    throw new Error(
      `SillyTavern UI did not become ready after ${UI_READY_ATTEMPTS} attempts`,
      { cause: uiError },
    );
  }

  try {
    await configureOpenRouter(page, workerId);
    setHealth(workerId, { providerReady: true });
    await selectDefaultCharacter(page);
    await selectWorkerChat(page, workerId);
    await connectExtension(page, bridgeUrl);
    setHealth(workerId, {
      bridgeConnected: true,
      lastProbeAt: Date.now(),
      lastError: "",
    });
    if (workerId === "worker-1") await capturePromptSnapshot(page);
  } catch (error) {
    setHealth(workerId, { lastError: error.message });
    throw error;
  }
}

async function runBrowserSession(workerId) {
  const launchOptions = {
    headless: true,
  };

  if (BASIC_AUTH_USERNAME && BASIC_AUTH_PASSWORD) {
    launchOptions.httpCredentials = {
      username: BASIC_AUTH_USERNAME,
      password: BASIC_AUTH_PASSWORD,
    };
  }

  const profileDirectory =
    WORKER_COUNT === 1 ? PROFILE_DIR : path.join(PROFILE_DIR, workerId);
  const bridgeUrl = bridgeUrlForWorker(workerId);
  const context = await chromium.launchPersistentContext(profileDirectory, launchOptions);
  activeContexts.set(workerId, context);

  await context.addInitScript((config) => {
    try {
      localStorage.setItem("language", config.uiLanguage);
    } catch {
      // localStorage is unavailable on the initial about:blank document.
    }
    Object.defineProperty(
      globalThis,
      "SILLYTAVERN_DISCORD_CONNECTOR_CONFIG",
      {
        configurable: false,
        enumerable: false,
        writable: false,
        value: Object.freeze(config),
      },
    );
  }, {
    bridgeUrl,
    workerId,
    autoConnect: true,
    uiLanguage: UI_LANGUAGE,
  });

  const pages = context.pages();
  const page = pages[0] || (await context.newPage());

  page.on("pageerror", (error) =>
    log("warn", `SillyTavern page error: ${error.message}`),
  );
  page.on("crash", () => log("error", "Chromium page crashed"));

  setHealth(workerId, { sessionStartedAt: Date.now(), lastError: "starting session" });
  await openSillyTavern(page, workerId, bridgeUrl);
  consecutiveSessionFailures.set(workerId, 0);

  while (!shuttingDown) {
    await delay(WATCH_INTERVAL_MS);
    if (page.isClosed()) throw new Error("SillyTavern page was closed");

    try {
      let providerReady = await providerIsConnected(page);
      let bridgeConnected = await connectorIsConnected(page);
      setHealth(workerId, {
        providerReady,
        bridgeConnected,
        lastProbeAt: Date.now(),
      });

      if (!providerReady) {
        log("warn", "AI provider disconnected; attempting to reconnect");
        await configureOpenRouter(page, workerId);
        providerReady = true;
      }
      if (!bridgeConnected) {
        log("warn", "Connector disconnected; attempting to reconnect");
        await connectExtension(page, bridgeUrl);
        bridgeConnected = true;
      }

      setHealth(workerId, {
        uiReady: true,
        providerReady,
        bridgeConnected,
        lastProbeAt: Date.now(),
        lastError: "",
      });
    } catch (error) {
      setHealth(workerId, {
        providerReady: false,
        bridgeConnected: false,
        lastError: `Readiness probe failed: ${error.message}`,
      });
      log("warn", `Readiness probe failed: ${error.message}; reloading page`);
      await openSillyTavern(page, workerId, bridgeUrl);
    }
  }
}

async function superviseWorker(workerId) {
  while (!shuttingDown) {
    try {
      await runBrowserSession(workerId);
    } catch (error) {
      if (!shuttingDown) {
        const failures = (consecutiveSessionFailures.get(workerId) || 0) + 1;
        consecutiveSessionFailures.set(workerId, failures);
        setHealth(workerId, {
          uiReady: false,
          providerReady: false,
          bridgeConnected: false,
          lastProbeAt: 0,
          lastError: error.message,
        });
        log("error", `[${workerId}] ${error.stack || error.message}`);
      }
    } finally {
      const context = activeContexts.get(workerId);
      if (context) {
        await context.close().catch(() => {});
        activeContexts.delete(workerId);
      }
    }

    if (!shuttingDown) {
      if ((consecutiveSessionFailures.get(workerId) || 0) >= SESSION_FAILURE_LIMIT) {
        throw new Error(
          `${workerId} failed ${SESSION_FAILURE_LIMIT} consecutive times`,
        );
      }
      log("info", `[${workerId}] Restarting browser session in 5 seconds`);
      await delay(5_000);
    }
  }
}

async function main() {
  await loadConfiguration();
  healthServer = startHealthServer();
  log("info", `Starting ${WORKER_COUNT} isolated headless SillyTavern worker(s)`);
  await Promise.all(
    Array.from({ length: WORKER_COUNT }, (_, index) =>
      superviseWorker(`worker-${index + 1}`),
    ),
  );
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log("info", `Received ${signal}; shutting down`);
  await Promise.all(
    [...activeContexts.values()].map((context) => context.close().catch(() => {})),
  );
  activeContexts.clear();
  if (healthServer) {
    await new Promise((resolve) => healthServer.close(resolve));
    healthServer = null;
  }
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

main().catch(async (error) => {
  log("error", error.stack || error.message);
  process.exitCode = 1;
  await shutdown("fatal worker failure");
});
