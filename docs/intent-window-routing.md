# Intent-Window Routing

Lynkr scores tier selection from user intent, not from the full request
payload. Intent is read as a recency-weighted window over the last N user
messages: each message is scored independently, the score is decayed by
its age, and the message with the highest weighted score determines the
tier.

The bandit explorer that sits on top of tier selection is constrained to
the models you've configured in `TIER_*`. The `*[Lynkr] …*` routing badge
rendered into the response is sanitised on the inbound side so it never
re-enters the model's context across turns.

---

## Tier picker

`pickTierByIntent` runs at the `/v1/messages` entry for every auth mode
(subscription, OAuth, PAYG). Subscription requests where the picked tier
resolves to `azure-anthropic` are forwarded byte-for-byte to
`api.anthropic.com` (anti-abuse stealth path). All other dispatches pin
the picked `(provider, model)` onto the request so the orchestrator
honours the intent-based decision.

### Scoring algorithm

For each of the last `N` user messages (age `0` is the latest):

```
weighted_score(msg) = raw_complexity_score(msg) × decay^age
```

The message with the highest `weighted_score` wins. Its provider, model,
tier, and raw score are returned as the routing decision.

### Worked example

`N = 5`, `decay = 0.7`. The latest user message is *"yes continue"*; an
"audit credentials" turn sits four messages back.

| Age | User said | Raw | Decay | Weighted |
|----:|---|---:|---:|---:|
| 4 | "audit auth for credential leaks" | 80 | 0.24 | **19.2** |
| 3 | "go ahead" | 5 | 0.34 | 1.7 |
| 2 | "what about session tokens?" | 25 | 0.49 | 12.3 |
| 1 | "thanks" | 3 | 0.70 | 2.1 |
| 0 | "yes continue" *(current)* | 5 | 1.00 | 5.0 |

Winner: the credential-audit message at age 4. The conversation stays on
the credentialing-appropriate tier even though the latest message is a
short acknowledgement. After roughly ten more "ok continue" turns the
audit signal decays to a negligible fraction of its raw score and the
conversation naturally returns to SIMPLE.

### Comparison with alternatives

| Approach | Recency? | Stickiness control | Cost behaviour |
|---|---|---|---|
| Latest message only | extreme | none | misses ongoing context |
| Sum / weighted-avg of all messages | none | permanent stick | every short follow-up inherits full history |
| **Window + decay, max-pool** | smooth | natural decay | catches earlier signals without inflation |

### Configuration

```env
# Window size: how many recent user messages contribute to scoring.
# Set 1 to score only the latest user message.
LYNKR_INTENT_WINDOW_N=5

# Per-turn exponential decay applied during window scoring.
# 0.5 = old turns fade fast; 0.9 = old turns linger.
LYNKR_INTENT_DECAY=0.7
```

Both are optional; defaults apply when unset.

### Implementation

| Symbol | Location |
|---|---|
| `pickTierByIntent(body)` | `src/api/router.js:41` |
| Window scoring loop | `src/api/router.js:99-128` |
| `_intentTier` request field | set at `src/api/router.js:896`, read by downstream badge/header logic |

---

## Tier-strict bandit

The LinUCB bandit at `src/routing/index.js:533-574` selects between the
tier's primary model and a kNN-suggested alternative drawn from the
historical request index. The kNN candidate is admitted into the bandit's
candidate set only if its `(provider, model)` pair appears in a
configured `TIER_*` entry.

In practice this means:

- A model credentialed in `.env` but never listed in any `TIER_*` line
  cannot surface as a bandit exploration arm.
- The bandit can still cross tier boundaries — e.g. for a SIMPLE request,
  it can pick a model you've listed under `TIER_COMPLEX` if the UCB score
  is higher.
- Tier configuration is the source of truth for what's eligible to be
  picked, regardless of which other provider credentials happen to be set.

### Tier introspection API

```js
const selector = require('./routing/model-tiers').getModelTierSelector();

selector.getModelsForTier('SIMPLE');
// → [{provider: 'ollama', model: 'minimax-m2.5:cloud'}]

selector.getAllConfiguredModels();
// → deduped union across SIMPLE, MEDIUM, COMPLEX, REASONING
```

`getModelsForTier` returns an array (one entry today) so the call sites
are forward-compatible with a multi-model tier syntax extension.

---

## Visible badge sanitisation

When `LYNKR_VISIBLE_ROUTING=true`, Lynkr prepends a routing badge to the
assistant response:

```
*[Lynkr] SIMPLE → minimax-m2.5:cloud (ollama) · score 21*
```

The badge is render-only — your TUI sees it, but it never re-enters the
model's context on subsequent turns. The sanitiser runs at two points:

1. `/v1/messages` entry — strips any `*[Lynkr] …*` content from the
   inbound `messages` array before history compression or the orchestrator
   touch it. This is the load-bearing strip.
2. Top of `invokeModel` — defense-in-depth in case a future code path
   bypasses the router entry.

Both string-shape and array-shape `assistant.content` are handled. The
matching regex is anchored at the start of a text block:

```
/^\*\[Lynkr\][^*\n]*\*\s*/
```

Implementation: `src/clients/databricks.js:2491` (`stripLynkrBadges`).

---

## Output-budget defaults

The Azure OpenAI Responses-API path caps `max_output_tokens` at 32768.
Long-form responses (multi-file explanations, large refactors) complete
without silent mid-stream truncation. Client-supplied `body.max_tokens`
is honoured up to the cap.

To raise the cap further, edit `azureOpenAIMaxOutput` in
`src/clients/databricks.js` at the top of `invokeAzureOpenAI`'s body
construction.

---

## Verifying behaviour

```bash
lynkr wrap claude
```

Inside the wrap session:

```
/clear
Read /path/to/your/project/CLAUDE.md and summarize in 2-3 bullets.
```

Expected: the badge renders on each assistant turn, the model fires the
file-read tool once, and a coherent summary comes back. Multi-turn
follow-ups stay on the same tier the initial scoring picked, modulo the
decay window surfacing earlier high-signal turns when relevant.

---

## Related

- [`wrap-guide.md`](./wrap-guide.md) — `lynkr wrap <target>` end-to-end
- [`oauth-subscription-routing.md`](./oauth-subscription-routing.md) —
  how subscription requests are dispatched
- [`routing-improvement-plan.md`](./routing-improvement-plan.md) —
  background design notes
