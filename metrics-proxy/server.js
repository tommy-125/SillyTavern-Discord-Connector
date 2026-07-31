"use strict";

const http = require("node:http");
const https = require("node:https");
const { randomUUID } = require("node:crypto");

const PORT = positiveInt(process.env.METRICS_PROXY_PORT, 8081);
const UPSTREAM_BASE_URL = String(
  process.env.METRICS_UPSTREAM_BASE_URL || "https://openrouter.ai/api/v1",
).replace(/\/+$/, "");
const RECORD_TTL_MS = positiveInt(
  process.env.METRICS_RECORD_TTL_SECONDS,
  600,
) * 1000;
const MAX_RECORDS = positiveInt(process.env.METRICS_MAX_RECORDS, 1000);
const FORCE_REASONING_EFFORT = String(
  process.env.OPENROUTER_FORCE_REASONING_EFFORT || "",
).trim().toLowerCase();
const PROVIDER_SORT = String(
  process.env.OPENROUTER_PROVIDER_SORT || "latency",
).trim().toLowerCase();
const MAX_BODY_BYTES = 16 * 1024 * 1024;

const records = [];

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function pruneRecords(now = Date.now()) {
  while (
    records.length > 0 &&
    (records.length > MAX_RECORDS || now - records[0].completedAt > RECORD_TTL_MS)
  ) {
    records.shift();
  }
}

function safeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function usageFromPayload(payload) {
  const usage = payload?.usage;
  if (!usage || typeof usage !== "object") return null;
  return {
    promptTokens: safeNumber(usage.prompt_tokens),
    completionTokens: safeNumber(usage.completion_tokens),
    totalTokens: safeNumber(usage.total_tokens),
    reasoningTokens: safeNumber(
      usage.completion_tokens_details?.reasoning_tokens ?? usage.reasoning_tokens,
    ),
    cachedTokens: safeNumber(
      usage.prompt_tokens_details?.cached_tokens ?? usage.cached_tokens,
    ),
    costUsd: safeNumber(usage.cost),
  };
}

function applyGenerationOverrides(payload, options = {}) {
  const forceReasoningEffort = options.forceReasoningEffort
    ?? FORCE_REASONING_EFFORT;
  const providerSort = options.providerSort ?? PROVIDER_SORT;
  payload.usage = { ...(payload.usage || {}), include: true };
  if (providerSort) {
    payload.provider = { ...(payload.provider || {}), sort: providerSort };
  }
  if (forceReasoningEffort) {
    // SillyTavern's custom OpenAI-compatible source does not reliably forward
    // its reasoning UI setting. Set the OpenRouter-native field here so the
    // provider cannot silently fall back to the model's default effort.
    payload.reasoning = forceReasoningEffort === "none"
      ? { enabled: false, exclude: true }
      : { effort: forceReasoningEffort };
    delete payload.reasoning_effort;
    delete payload.include_reasoning;
  }
  return payload;
}

function parseSseEvents(state, chunk, onPayload) {
  state.buffer += chunk;
  while (true) {
    const boundary = state.buffer.indexOf("\n\n");
    if (boundary < 0) break;
    const event = state.buffer.slice(0, boundary);
    state.buffer = state.buffer.slice(boundary + 2);
    for (const line of event.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const value = line.slice(5).trim();
      if (!value || value === "[DONE]") continue;
      try {
        onPayload(JSON.parse(value));
      } catch {
        // Ignore non-JSON provider keepalive data.
      }
    }
  }
}

function buildUpstreamUrl(requestUrl) {
  const url = new URL(requestUrl, "http://metrics-proxy.invalid");
  const suffix = url.pathname.replace(/^\/v1(?=\/|$)/, "");
  return `${UPSTREAM_BASE_URL}${suffix}${url.search}`;
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("request body is too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function requestHeaders(request) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (
      value == null ||
      ["host", "content-length", "connection", "accept-encoding"].includes(name)
    ) {
      continue;
    }
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  return headers;
}

function responseHeaders(upstream) {
  const result = {};
  const entries = upstream.headers instanceof Headers
    ? upstream.headers
    : Object.entries(upstream.headers || {});
  for (const [name, value] of entries) {
    if (["content-length", "content-encoding", "transfer-encoding", "connection"].includes(name)) {
      continue;
    }
    result[name] = value;
  }
  return result;
}

function upstreamHeader(upstream, name) {
  if (upstream.headers instanceof Headers) return upstream.headers.get(name);
  const value = upstream.headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value || null;
}

function requestUpstream(url, { method, headers, body }) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const client = target.protocol === "https:" ? https : http;
    const headerObject = Object.fromEntries(headers);
    if (body) headerObject["content-length"] = String(body.length);
    const request = client.request(
      target,
      {
        method,
        headers: headerObject,
        // Podman's network has no working IPv6 route. Node fetch's automatic
        // family selection intermittently timed out even when IPv4 was healthy.
        family: 4,
      },
      resolve,
    );
    request.on("error", reject);
    request.end(body);
  });
}

function writeJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function claimRecords(since) {
  pruneRecords();
  const threshold = Number.isFinite(since) ? since : 0;
  const claimed = records.filter(
    (record) => !record.claimed && record.startedAt >= threshold,
  );
  for (const record of claimed) record.claimed = true;
  return claimed.map(({ claimed: _claimed, ...record }) => record);
}

async function proxyRequest(request, response) {
  const startedAt = Date.now();
  const isGeneration =
    request.method === "POST" &&
    new URL(request.url, "http://metrics-proxy.invalid").pathname.endsWith(
      "/chat/completions",
    );
  let body = ["GET", "HEAD"].includes(request.method) ? undefined : await readBody(request);
  let requestedModel = "";
  let streamed = false;

  if (isGeneration && body?.length) {
    try {
      const parsed = JSON.parse(body.toString("utf8"));
      requestedModel = String(parsed.model || "");
      streamed = parsed.stream === true;
      applyGenerationOverrides(parsed);
      body = Buffer.from(JSON.stringify(parsed));
    } catch {
      // Forward malformed JSON unchanged so the upstream returns its normal error.
    }
  }

  const upstream = await requestUpstream(buildUpstreamUrl(request.url), {
    method: request.method,
    headers: requestHeaders(request),
    body,
  });
  const headersAt = Date.now();
  response.writeHead(upstream.statusCode, responseHeaders(upstream));

  let firstTokenAt = null;
  let usage = null;
  let responseModel = "";
  let finishReason = "";
  const generationId =
    upstreamHeader(upstream, "x-generation-id") || randomUUID();
  const contentType = upstreamHeader(upstream, "content-type") || "";
  const sseState = { buffer: "" };
  const responseChunks = [];
  let responseBytes = 0;

  const inspectPayload = (payload) => {
    if (payload?.model) responseModel = String(payload.model);
    const delta = payload?.choices?.[0]?.delta?.content;
    if (firstTokenAt == null && typeof delta === "string" && delta.length > 0) {
      firstTokenAt = Date.now();
    }
    const reason = payload?.choices?.[0]?.finish_reason;
    if (reason) finishReason = String(reason);
    usage = usageFromPayload(payload) || usage;
  };

  if (upstream) {
    const decoder = new TextDecoder();
    for await (const chunk of upstream) {
      const buffer = Buffer.from(chunk);
      response.write(buffer);
      if (isGeneration) {
        if (contentType.includes("text/event-stream")) {
          parseSseEvents(sseState, decoder.decode(buffer, { stream: true }).replace(/\r\n/g, "\n"), inspectPayload);
        } else if (responseBytes < MAX_BODY_BYTES) {
          responseChunks.push(buffer);
          responseBytes += buffer.length;
        }
      }
    }
  }
  response.end();

  if (!isGeneration) return;
  if (!contentType.includes("text/event-stream") && responseChunks.length) {
    try {
      inspectPayload(JSON.parse(Buffer.concat(responseChunks).toString("utf8")));
    } catch {
      // The upstream error body may not be JSON.
    }
  }

  const completedAt = Date.now();
  records.push({
    generationId,
    startedAt,
    completedAt,
    headersMs: headersAt - startedAt,
    firstTokenMs: firstTokenAt == null ? null : firstTokenAt - startedAt,
    durationMs: completedAt - startedAt,
    model: responseModel || requestedModel,
    streamed,
    statusCode: upstream.statusCode,
    finishReason,
    usageAvailable: usage != null,
    ...(usage || {}),
    claimed: false,
  });
  pruneRecords(completedAt);
}

async function handler(request, response) {
  const url = new URL(request.url, "http://metrics-proxy.invalid");
  if (request.method === "GET" && url.pathname === "/health") {
    writeJson(response, 200, { status: "ok", upstream: UPSTREAM_BASE_URL });
    return;
  }
  if (request.method === "GET" && url.pathname === "/internal/metrics/claim") {
    writeJson(response, 200, {
      records: claimRecords(Number(url.searchParams.get("since"))),
    });
    return;
  }
  try {
    await proxyRequest(request, response);
  } catch (error) {
    if (!response.headersSent) {
      writeJson(response, 502, { error: { message: "upstream request failed" } });
    } else {
      response.destroy();
    }
    console.error(`[metrics-proxy] ${error.message}`);
  }
}

function startServer(port = PORT) {
  return http.createServer(handler).listen(port, "0.0.0.0", () => {
    console.log(`[metrics-proxy] listening on 0.0.0.0:${port}`);
  });
}

if (require.main === module) startServer();

module.exports = {
  applyGenerationOverrides,
  buildUpstreamUrl,
  claimRecords,
  parseSseEvents,
  requestUpstream,
  startServer,
  usageFromPayload,
};
