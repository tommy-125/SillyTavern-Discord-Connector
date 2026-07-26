"use strict";

const { createHash } = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { chromium } = require("playwright");

const ST_URL = process.env.SILLYTAVERN_URL || "http://sillytavern:8000";
const BRIDGE_URL =
  process.env.CONNECTOR_BRIDGE_URL || "ws://discord-bridge:2333";
const PROFILE_DIR = process.env.BROWSER_PROFILE_DIR || "/data/profile";
const UI_TIMEOUT_MS = positiveInt(
  process.env.CONNECTOR_UI_TIMEOUT_MS,
  120_000,
);
const WATCH_INTERVAL_MS = positiveInt(
  process.env.CONNECTOR_WATCH_INTERVAL_MS,
  15_000,
);
const BASIC_AUTH_USERNAME = process.env.ST_BASIC_AUTH_USERNAME || "";
const BASIC_AUTH_PASSWORD = process.env.ST_BASIC_AUTH_PASSWORD || "";
const OPENROUTER_MODEL = (process.env.OPENROUTER_MODEL || "").trim();
const DEFAULT_CHARACTER = (process.env.ST_DEFAULT_CHARACTER || "").trim();
const DEFAULT_PERSONA = (process.env.ST_DEFAULT_PERSONA || "User").trim();
const UI_LANGUAGE = (process.env.ST_UI_LANGUAGE || "en").trim();
const PROMPT_SNAPSHOT_PATH = (
  process.env.CONNECTOR_PROMPT_SNAPSHOT_PATH || ""
).trim();
const PROMPT_SNAPSHOT_TEST_MESSAGE = (
  process.env.CONNECTOR_PROMPT_SNAPSHOT_TEST_MESSAGE || ""
).trim();
const OPENROUTER_KEY_MARKER = path.join(
  PROFILE_DIR,
  ".openrouter-key.sha256",
);

let shuttingDown = false;
let activeContext = null;
let openRouterApiKey = "";

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
}

async function configureOpenRouter(page) {
  await page.waitForSelector("#main_api", {
    state: "attached",
    timeout: UI_TIMEOUT_MS,
  });
  await page.waitForSelector("#chat_completion_source", {
    state: "attached",
    timeout: UI_TIMEOUT_MS,
  });

  const keyHash = createHash("sha256").update(openRouterApiKey).digest("hex");
  const previousKeyHash = (await readOptionalFile(OPENROUTER_KEY_MARKER)).trim();

  const wroteSecret = await page.evaluate(
    async ({ apiKey, shouldReplaceSecret }) => {
      const secrets = await import("/scripts/secrets.js");
      const secretExists = Boolean(
        secrets.secret_state?.api_key_openrouter,
      );

      if (shouldReplaceSecret || !secretExists) {
        const id = await secrets.writeSecret(
          "api_key_openrouter",
          apiKey,
          "Docker OpenRouter key",
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
      if (source.value !== "openrouter") {
        globalThis.jQuery(source).val("openrouter").trigger("change");
      }

      return shouldReplaceSecret || !secretExists;
    },
    {
      apiKey: openRouterApiKey,
      shouldReplaceSecret: previousKeyHash !== keyHash,
    },
  );

  if (wroteSecret) {
    await fs.mkdir(PROFILE_DIR, { recursive: true });
    await fs.writeFile(OPENROUTER_KEY_MARKER, `${keyHash}\n`, {
      mode: 0o600,
    });
  }

  try {
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

  await page.evaluate((model) => {
    const select = document.querySelector("#model_openrouter_select");
    if (!(select instanceof HTMLSelectElement)) {
      throw new Error("SillyTavern OpenRouter model selector is unavailable");
    }
    globalThis.jQuery(select).val(model).trigger("change");
  }, OPENROUTER_MODEL);

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
    throw new Error("SillyTavern did not connect to OpenRouter in time");
  }

  log("info", `OpenRouter is ready with model ${OPENROUTER_MODEL}`);
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

async function completeOnboarding(page) {
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
    { timeout: UI_TIMEOUT_MS },
  );

  const onboarding = page.locator("dialog.popup[open] .onboarding");
  if (!(await onboarding.count())) return;

  const popup = onboarding.locator("xpath=ancestor::dialog");
  await popup.locator(".popup-input").fill(DEFAULT_PERSONA || "User");
  await popup.locator(".popup-button-ok").click();
  await onboarding.waitFor({ state: "hidden", timeout: UI_TIMEOUT_MS });

  log("info", `Completed SillyTavern onboarding as ${DEFAULT_PERSONA || "User"}`);
}

async function connectorIsConnected(page) {
  return page.evaluate(() => {
    const status = document.querySelector("#discord_connection_status");
    return Boolean(status && status.style.color === "green");
  });
}

async function connectExtension(page) {
  await page.waitForSelector("#discord_bridge_url", {
    state: "attached",
    timeout: UI_TIMEOUT_MS,
  });

  if (await connectorIsConnected(page)) {
    log("info", `Connector is connected to ${BRIDGE_URL}`);
    return;
  }

  await page.evaluate(() => {
    const connect = document.querySelector("#discord_connect_button");
    if (!(connect instanceof HTMLInputElement)) {
      throw new Error("Discord Connector connect button is unavailable");
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

  log("info", `Connector is connected to ${BRIDGE_URL}`);
}

async function capturePromptSnapshot(page) {
  if (!PROMPT_SNAPSHOT_PATH) return;

  const snapshot = await page.evaluate(async (testMessage) => {
    const sillyTavern = await import("/script.js");
    const insertedTestMessage = Boolean(testMessage);
    if (insertedTestMessage) {
      sillyTavern.chat.push({
        name: sillyTavern.name1 || "User",
        is_user: true,
        is_system: false,
        send_date: new Date().toISOString(),
        mes: testMessage,
        extra: { prompt_snapshot_only: true },
      });
    }

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
      if (insertedTestMessage) sillyTavern.chat.pop();
    }
  }, PROMPT_SNAPSHOT_TEST_MESSAGE);

  await fs.mkdir(path.dirname(PROMPT_SNAPSHOT_PATH), { recursive: true });
  await fs.writeFile(
    PROMPT_SNAPSHOT_PATH,
    `${JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        source: "SillyTavern Generate(normal, {}, true)",
        testMessage: PROMPT_SNAPSHOT_TEST_MESSAGE || null,
        messages: snapshot,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  log("info", `Captured dry-run prompt snapshot at ${PROMPT_SNAPSHOT_PATH}`);
}

async function openSillyTavern(page) {
  log("info", `Opening ${ST_URL}`);
  await page.goto(ST_URL, {
    // A restored SillyTavern profile can keep DOMContentLoaded pending while
    // extensions restore their state. Continue once the server response is
    // committed and use the explicit UI selectors below as readiness checks.
    waitUntil: "commit",
    timeout: UI_TIMEOUT_MS,
  });
  log("info", "SillyTavern navigation committed; waiting for the UI");
  await completeOnboarding(page);
  // This UI is added only after SillyTavern has loaded its settings and
  // initialized extensions, so it doubles as an application-ready signal.
  await page.waitForSelector("#discord_bridge_url", {
    state: "attached",
    timeout: UI_TIMEOUT_MS,
  });
  await configureOpenRouter(page);
  await selectDefaultCharacter(page);
  await connectExtension(page);
  await capturePromptSnapshot(page);
}

async function runBrowserSession() {
  const launchOptions = {
    headless: true,
  };

  if (BASIC_AUTH_USERNAME && BASIC_AUTH_PASSWORD) {
    launchOptions.httpCredentials = {
      username: BASIC_AUTH_USERNAME,
      password: BASIC_AUTH_PASSWORD,
    };
  }

  const context = await chromium.launchPersistentContext(
    PROFILE_DIR,
    launchOptions,
  );
  activeContext = context;

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
    bridgeUrl: BRIDGE_URL,
    autoConnect: true,
    uiLanguage: UI_LANGUAGE,
  });

  const pages = context.pages();
  const page = pages[0] || (await context.newPage());

  page.on("pageerror", (error) =>
    log("warn", `SillyTavern page error: ${error.message}`),
  );
  page.on("crash", () => log("error", "Chromium page crashed"));

  await openSillyTavern(page);

  while (!shuttingDown) {
    await delay(WATCH_INTERVAL_MS);
    if (page.isClosed()) throw new Error("SillyTavern page was closed");

    if (!(await connectorIsConnected(page))) {
      log("warn", "Connector disconnected; attempting to reconnect");
      try {
        await connectExtension(page);
      } catch (error) {
        log("warn", `Reconnect failed: ${error.message}; reloading page`);
        await openSillyTavern(page);
      }
    }
  }
}

async function main() {
  await loadConfiguration();
  log("info", "Starting persistent headless Chromium session");

  while (!shuttingDown) {
    try {
      await runBrowserSession();
    } catch (error) {
      if (!shuttingDown) {
        log("error", `${error.stack || error.message}`);
      }
    } finally {
      if (activeContext) {
        await activeContext.close().catch(() => {});
        activeContext = null;
      }
    }

    if (!shuttingDown) {
      log("info", "Restarting browser session in 5 seconds");
      await delay(5_000);
    }
  }
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log("info", `Received ${signal}; shutting down`);
  if (activeContext) await activeContext.close().catch(() => {});
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

main().catch((error) => {
  log("error", error.stack || error.message);
  process.exitCode = 1;
});
