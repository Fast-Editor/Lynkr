# opencode Integration

Point opencode at Lynkr with **honest per-tier context windows**, so
opencode's own compaction always matches the model actually serving.

## Setup

```bash
lynkr run opencode                      # refresh config, then launch opencode
lynkr run opencode --path ./opencode.json   # project-scoped config
lynkr run opencode --base-url http://host:8081
lynkr run opencode --dry-run            # preview, write and launch nothing
lynkr run opencode -- --help            # pass args through to opencode
```

Reads your live `TIER_*` config and the model registry, and writes a
`provider.lynkr` block (non-destructive merge — every other key in an
existing config is preserved):

| opencode model | Pins tier | `limit.context` |
|---|---|---|
| `lynkr-auto` | none — full content routing | **minimum** across your tiers (safe for whatever routing picks) |
| `lynkr-simple` | SIMPLE | that tier's model's real window |
| `lynkr-medium` | MEDIUM | " |
| `lynkr-complex` | COMPLEX | " |
| `lynkr-reasoning` | REASONING | " |

## Why per-tier entries instead of one "auto" model

opencode compacts based on one static `limit.context` per model entry — it
cannot track a router that serves different models per request. One blended
number is wrong in both directions (too big → compaction fires too late and
the server has to mechanically squeeze history; too small → big models
wasted). Per-tier entries dissolve the problem: **picking a model in
opencode's picker pins that tier** (see [tier-pinning.md](tier-pinning.md)),
so the window the entry advertises is the window that actually serves it —
compaction budgets are correct per model, statically, no plugin required.

`lynkr-auto` keeps full content-based routing at the cost of compacting at
the safest (minimum) window.

## Notes

- The virtual ids (`lynkr-simple` … `lynkr-reasoning`) resolve to tier pins
  on the server (`src/routing/model-slots.js`) — they work from any client,
  not just opencode.
- Server-side budgets are independently pin-aware (the compressor targets
  the pinned model's real window) and every response carries
  [`X-Lynkr-Context-Window`](context-window-header.md) for clients that can
  read headers.
- If a tier model has no registry context window, its entry floors to the
  minimum known window (never guesses upward). Fix with a
  `MODEL_PRICE_OVERRIDES` entry carrying a `context` field.
- `lynkr run opencode` recomputes the windows on every launch, so `TIER_*`
  changes are picked up automatically. (Plain `opencode` also works once configured — the windows just stay as last written.)
