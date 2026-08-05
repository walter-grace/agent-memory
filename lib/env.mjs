// Secret loading for the CLI + scripts. No secrets live in this repo: copy .env.example to .env
// (gitignored) and fill it in, or export the same names into your shell environment. Values are read
// from the process environment first, then a repo-local .env, so nothing is ever hardcoded to a path.
import { readFileSync } from "node:fs";

let cache = null;
function fileEnv() {
  if (cache) return cache;
  cache = {};
  try {
    const txt = readFileSync(new URL("../.env", import.meta.url), "utf8");
    for (const line of txt.split("\n")) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !line.trim().startsWith("#")) cache[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch { /* no .env file: fall back to process.env */ }
  return cache;
}

export function envVar(name, { required = true } = {}) {
  const v = process.env[name] ?? fileEnv()[name];
  if (!v && required) throw new Error(`Missing ${name}. Copy .env.example to .env and set it, or export ${name} in your shell.`);
  return v || "";
}

// Normalize a 32-byte hex private key (with or without 0x) to 0x-prefixed.
export function privateKey(name = "PRIVATE_KEY") {
  const m = envVar(name).match(/(0x)?([0-9a-fA-F]{64})/);
  if (!m) throw new Error(`${name} must be a 32-byte hex private key.`);
  return "0x" + m[2];
}
