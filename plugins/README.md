# Plugin packs

A plugin pack is one directory under `plugins/`. One pack = one user-visible
capability (a learning mode, a question bank, an export target), not one
function. The kernel discovers packs, validates `plugin.json`, and calls their
`entry` module once at startup.

```
plugins/
  mode-draw/
    plugin.json     # the contract: id, apiVersion, provides, consumes, ui
    host.js         # ESM entry, `export default function register(api, ctx)`
    client.jsx      # optional panel, compiled into the client bundle
    test/           # optional, must be a node:test file
```

`plugin.json`:

```jsonc
{
  "id": "draw",                    // [a-z0-9-], unique
  "apiVersion": 1,                 // must match sdk/protocol.js API_VERSION
  "name": "绘图理解",
  "description": "先让学员画，再对照讲解",
  "entry": "./host.js",            // ESM, default export = register(api, ctx)
  "client": "./client.jsx",        // optional panel component
  "provides": { "mode": "draw", "tools": ["draw_render", "draw_grade"] },
  "consumes": ["books", "progress", "llm"]
}
```

Hard rules, enforced by `scripts/check-plugins.mjs` and `scripts/check-imports.mjs`:

1. **No sideways imports.** A pack may import `node:*` (except `node:fs` and
   `node:child_process`), `../../sdk/*`, and its own relative files. Importing
   another pack is a build error.
2. **No credentials, no direct model calls.** Model access goes through the
   `llm` service the kernel injects.
3. **No filesystem access.** The `node:fs` ban is what makes "plugins cannot
   touch `kp/*.md`" a fact rather than a promise; record attempts through
   `progress.append()` and store state via the host-provided path.
4. **Book-scoped state only.** Persist under the paths the host hands you, never
   into the user's book directory directly.
