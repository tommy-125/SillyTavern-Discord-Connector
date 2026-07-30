import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeEnvPath = path.join(root, ".env");
const botEnvPath = path.resolve(root, "..", "kurohelper", ".env");
const runtimeConfigPath = path.join(root, "server", "config.js");
const secret = crypto.randomBytes(48).toString("base64url");

function upsertEnv(filePath, key, value) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing ${filePath}; create it from .env.example first.`);
  }
  const newline = fs.readFileSync(filePath, "utf8").includes("\r\n")
    ? "\r\n"
    : "\n";
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  const prefix = `${key}=`;
  const index = lines.findIndex((line) => line.startsWith(prefix));
  if (index >= 0) lines[index] = prefix + value;
  else lines.push(prefix + value);
  fs.writeFileSync(filePath, lines.join(newline), "utf8");
}

function removeConfigFallback() {
  if (!fs.existsSync(runtimeConfigPath)) return;
  const source = fs.readFileSync(runtimeConfigPath, "utf8");
  const updated = source.replace(
    /(kurohelper\s*:\s*\{[\s\S]*?\bsecret\s*:\s*)["'][^"']*["']/,
    '$1""',
  );
  fs.writeFileSync(runtimeConfigPath, updated, "utf8");
}

upsertEnv(runtimeEnvPath, "KUROHELPER_BRIDGE_SECRET", secret);
upsertEnv(botEnvPath, "KURO_RUNTIME_SECRET", secret);
removeConfigFallback();

console.log("KuroHelper runtime secret was generated and synchronized without printing it.");
