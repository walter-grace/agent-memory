#!/usr/bin/env node
// Launcher so `npx hero-memory-proxy` works verbatim. The real proxy lives in
// @herorun/agent-memory (node/proxy.mjs); this package exists only because npx
// resolves a PACKAGE name, and the main package is scoped.
import "@herorun/agent-memory/node/proxy";
