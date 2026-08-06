# Next steps: the memory proxy

Picking this back up. Written 2026-08-06.

## Where it stands

`node/proxy.mjs` is built, tested, and pushed to `master` (commit `1ec03cf`). It is an
OpenAI-compatible endpoint that forwards inference upstream and, on the side, encrypts every exchange
and checkpoints it to your agent NFT on Robinhood Chain. Point any harness at it with one env var and
its memory becomes wallet-owned and portable.

**Verified working:** repo tests 9/9; wallet auto-generated on first run; config written `0600` in a
`0700` directory; a second run returns the SAME wallet (no silent overwrite, which would orphan all
memory since the wallet IS the decryption key); `--import` adopts an existing key and clears a stale
agentId; a malformed key is rejected with a clear message; upstream forwarding relays the exact status
(tested against a real 401) and records nothing on the error path.

**Decision made:** NOT publishing to npm for now. Keeping the repo private. `npm publish` would make
the code permanently public regardless of repo visibility (the tarball carries `node/`, `browser/`,
`contracts/`), and a genuinely private scoped package needs a paid npm org plus consumer auth tokens,
which would break the "anyone can connect their harness" premise anyway. Revisit when you want reach.

## TODO when you return

### 1. Commit the README correction (uncommitted, do this first)
The README previously told people to run `npx hero-memory-proxy`, which does not work: the package is
unpublished, and even published, `npx <name>` resolves a PACKAGE of that name while the bin lives
inside `agent-memory`. It now documents the clone + `npm link` flow instead, which does work.

```bash
cd ~/Desktop/agent-memory
git add -A && git commit -m "README: document the clone + npm link flow, the npx command was not real"
git push origin master
```

### 2. Live end-to-end test (the last unproven mile)
Everything is verified except an actual on-chain checkpoint, which needs a funded wallet and a real
Hero Run key. The write path reuses `OnchainMemory.append`, the same code the web app and CLI already
run in production, so the risk is low, but it has not been executed through the proxy.

```bash
node node/proxy.mjs --whoami          # fund the printed address with a little RH ETH (chain 4663)
node node/proxy.mjs --mint "test-agent"
node node/proxy.mjs                   # leave running
# in another shell, one call through it:
curl -s http://localhost:8788/v1/chat/completions \
  -H "Authorization: Bearer hr_live_..." -H "Content-Type: application/json" \
  -d '{"model":"auto","messages":[{"role":"user","content":"remember: the launch is Tuesday"}]}' > /dev/null
# default batch is 5, so force the flush by stopping the proxy (Ctrl-C flushes)
```
Then confirm the agent and its checkpoint appear at https://herorunai.com/memory-graph. If it lands,
the whole thesis is proven: an arbitrary OpenAI harness minting wallet-owned memory to the chain.

### 3. Verify `npm link` actually works
`node/proxy.mjs` has a `#!/usr/bin/env node` shebang and `package.json` declares
`bin: { "hero-memory-proxy": "node/proxy.mjs" }`, but the file's executable bit was set locally and may
not have survived the commit. If `npm link` then `hero-memory-proxy` fails with a permission error:
```bash
chmod +x node/proxy.mjs && git update-index --chmod=+x node/proxy.mjs && git commit -m "proxy: executable bit"
```

### 4. If you later decide to publish
Two blockers, both already scouted:
- The npm name `agent-memory` is TAKEN (owner `kenryu`, v1.0.0). Use `@herorun/agent-memory` (scoped
  names need `publishConfig: { access: "public" }` or npm defaults them to restricted).
- For `npx hero-memory-proxy` to work verbatim, publish a second tiny package literally named
  `hero-memory-proxy` (the name IS available) that depends on the scoped one and re-exports the bin.
  Otherwise the command is `npx -p @herorun/agent-memory hero-memory-proxy`.
- Make the GitHub repo public in the same motion. An npm package pointing at a private repo reads badly
  for something meant to be adopted.

### 5. Open product question
Whether to offer a **managed mode** where Hero Run custodies a wallet so an `hr_live_` key alone is
enough. It would grow adoption and it would mean being honest that those users' memory is readable by
us, which is the one property this project exists to protect. Not started, deliberately.
