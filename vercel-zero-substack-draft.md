# Vercel's Zero and the Bet That Compilers Should Speak JSON

*A new systems language argues the bottleneck in agentic coding isn't the model — it's the toolchain.*

---

A Vercel engineer named Chris Tate spent three days building a programming language. He shipped it on May 15. It got 900 GitHub stars in the first 24 hours and a small storm of skeptical reactions from people who, fairly, asked whether the world needs another systems language.

It probably doesn't. But [Zero](https://github.com/vercel-labs/zero) isn't really arguing for a new language. It's arguing for a new **compiler contract** — and the language is the demo.

Tate's pitch, from [his launch tweet](https://x.com/ctatedev/status/2055434061322039377):

> I wanted a systems language that was faster, smaller, and easier for agents to use and repair. Explicit capabilities. JSON diagnostics. Typed safe fixes. Made for agents on day zero.

The interesting words there aren't "language." They're "diagnostics," "fixes," and "capabilities." Zero is a prototype of what dev tooling looks like when an LLM is the primary user.

## The example that explains the whole project

When a coding agent hits a compile error in `rustc` or `gcc` today, here's what happens: the compiler prints a sentence designed for a human, the agent runtime captures stdout, the LLM re-parses that English back into structured intent, and *then* it decides what to change. It mostly works. It also throws away the one thing the compiler already knew — exactly what's wrong, where it is, and what category of fix it needs.

Run `zero check --json` on a broken file and you get this instead:

```json
{
  "ok": false,
  "diagnostics": [{
    "code": "NAM003",
    "message": "unknown identifier",
    "line": 3,
    "repair": { "id": "declare-missing-symbol" }
  }]
}
```

Four things here are doing real work:

1. **`code: "NAM003"`** — a stable error code with a versioning guarantee. `NAM003` means "unknown identifier" in Zero today, and it will mean the same thing in the next compiler version. Agents can pattern-match on it instead of on prose.
2. **`repair.id: "declare-missing-symbol"`** — a *typed* fix category. The agent doesn't read the message to decide what to do. It branches on the ID.
3. **`line: 3`** — structured location, no regex required.
4. **`message`** — kept around for humans, but no longer load-bearing.

Compare to `rustc`. Rust's diagnostics are some of the best in the industry, and `cargo --message-format=json` exists. But the error codes are documentation pointers, not action verbs, and the JSON envelope still contains prose where the fix lives. Zero inverts that: the prose is the optional layer.

## The repair loop, not just the error

JSON output is the table-stakes part. The interesting move is `zero fix --plan --json`, which emits a *fix plan* — a typed description of exactly which changes to make, not a hint to interpret:

```bash
zero fix --plan --json main.0
```

The compiler is, in effect, generating an edit script. The agent's job collapses from "read English, infer intent, generate code, hope it compiles" to "apply this plan, verify, move on." Anyone who's built agent loops knows that second job is dramatically more reliable.

Pair that with two more pieces:

- `zero explain <code>` — returns structured docs for any diagnostic code. The agent hits `NAM003`, calls `zero explain NAM003`, gets back a precise description without scraping documentation that might be out of sync with the compiler it's actually running.
- `zero skills get zero --full` — dumps version-matched language guidance the agent can load into context. The docs it reads are pinned to the compiler version it's invoking, not whatever was scraped six months ago.

That last one is sneaky-important. **Documentation drift is one of the largest unforced errors in agentic coding.** Zero treats the docs as a versioned artifact of the compiler itself.

## The CLI is a JSON API in disguise

This is the part that doesn't get enough attention. Almost every Zero subcommand has a `--json` flag, and the schemas are consistent:

```bash
zero check    --json   # diagnostics
zero fix      --plan --json   # fix plans
zero graph    --json   # module dependency graph
zero size     --json   # binary size breakdown
zero routes   --json   # web route introspection
zero doctor   --json   # environment health
```

The compiler isn't a CLI. It's an API that happens to be invoked via a CLI. Every artifact an agent might want — diagnostics, fix plans, the dep graph, size reports, routes — comes out as structured data with the same envelope shape. That uniformity is the actual product.

## The language design supports the contract

Zero isn't just a normal language with a JSON flag bolted on. The syntax itself is built to make agent reasoning easier. A small example:

```
fun answer() -> i32 {
  return 40 + 2
}

pub fun main(world: World) -> Void raises {
  let value = answer()
  check world.out.write("math works\n")
}
```

Two design choices are doing the heavy lifting:

**Capability-based I/O.** That `world: World` parameter isn't decoration. A function without `World` *cannot perform I/O* — the compiler enforces it. For an agent, this is a gift: the type signature is a complete declaration of side effects. You don't need to read the body to know whether a function touches the network or the filesystem.

**Explicit effects.** `raises` marks fallibility in the signature. `check` is the keyword for fallible calls. Compare to Go, where any function can return an error and you have to read every line to know if it does, or Rust, where error handling is scattered across `?`, `unwrap`, `match`, and `map_err`. Zero collapses it to one shape.

The thesis underneath: **the more invariants the compiler can guarantee, the smaller the surface area the agent has to reason about.** Capability-based I/O isn't a new idea (see: Roc, E, parts of Haskell's `IO`). What's new is wielding it as an agent-affordance instead of a correctness one.

## Some details that change the read on this

A few facts that didn't make it into most of the launch coverage:

- **It was built in three days.** That's the lede most write-ups buried. Zero isn't a five-year language effort — it's a manifesto with a working compiler attached. Read it that way and the "this isn't Rust-grade" complaints land softer.
- **No LLVM.** The compiler ships its own backend. That's how it gets sub-10 KiB native binaries — no runtime, no GC, no event loop, no LLVM tax. Source files are `.0`. Targets currently include `linux-musl-x64`.
- **One critic's actual take.** Developer Mehul Mohan, who tried Zero on day one, summarized it as ["Rust with a basic (not Rust-grade) borrow checker."](https://yeamt.com/vercel-zero-programming-language-for-ai-agents/) That's accurate. Zero is not trying to beat Rust on memory safety. It's trying to beat Rust on agent-readability of the toolchain.
- **It's experimental.** Pre-1.0, v0.1.1, Apache-2.0, no package registry, no stable spec, no production claim. Vercel Labs says "experiment, not a production dependency" and means it.

## "But LLMs already handle Rust errors fine"

Yes, they do. This is the strongest pushback, and it shows up in nearly every critical reaction. Claude and GPT-5 can already round-trip a Rust compile error and produce a working fix most of the time. So what does Zero actually buy you?

A few things, none of which are knockouts on their own:

**Determinism.** "Most of the time" hides a long tail. An agent that branches on `NAM003` behaves identically across runs. An agent that parses prose doesn't. For autonomous loops running unattended, the variance matters more than the average.

**Cost.** Reading a 400-token error and re-deriving its meaning burns tokens on every iteration. Branching on a 12-character repair ID doesn't. In a tight inner loop — check → fix → re-check — this compounds fast.

**Versioning.** When `rustc` rewrites an error message for clarity (which they do, constantly, and correctly), every agent prompt that learned the old phrasing degrades. Stable error codes are an API contract. Prose is not.

**Smaller models become viable.** If the compiler does the interpretation work, you don't need a frontier model to handle the fix loop. You need a model good enough to *apply* a structured plan. That's a different — and much cheaper — problem.

None of these advantages are unique to Zero. Any compiler could ship a `--agent` mode tomorrow. The bet Vercel is making is that doing this *natively* — with the language designed around the contract — produces a better result than retrofitting it onto C, Rust, or Go.

## What Zero is *not*

Worth being clear about, because the launch coverage muddled this:

- **Not a Vercel product.** Vercel Labs ships experiments; Zero is one. No hosted runtime, no Vercel-specific deployment path.
- **Not a JavaScript replacement.** Zero lives in the C/Rust/Zig design space — manual memory, native binaries, no runtime. Don't build a React app with it.
- **Not stable.** v0.1.1. Things will break.
- **Not "AI wrote a language."** Chris Tate designed it. The agent-affordance is *who it's for*, not *what built it*.

## The interesting question this raises

Forget Zero for a second. The real question is whether **toolchains across the board are about to fork into human-facing and agent-facing modes.**

A few things start looking obvious once you've stared at Zero's design:

- `cargo`, `npm`, `go`, `pytest`, `eslint` already have JSON output flags. Almost none of them have *stable repair IDs*. That's the missing layer.
- Documentation is going to get versioned the way schemas are. The "fetch the docs that match the version of the tool you're using" pattern (Zero's `skills get`) is going to show up everywhere.
- The agent's job is going to shrink toward orchestration; the tool's job is going to grow toward emitting machine-actionable output. The capability boundary between "agent" and "tool" is going to move.

Zero may not win. It probably won't. The language itself is too thin and too new, and the moat is in the toolchain contract, not the syntax. But the pattern it's prototyping — **the compiler is an API, the prose is optional, the repair is typed** — is going to bleed into every serious dev tool within two years.

## What to actually do with this

If you're building agent loops on existing languages, take 20 minutes and read Zero's diagnostic spec. Steal the error code + repair ID schema. Apply it to whatever linter or checker you wrap. You don't need Zero to use the pattern.

If you're writing a CLI tool meant to be used by agents, ship a `--json` mode where the IDs are stable across versions. Document the IDs separately from their messages. Pin docs to versions. This is the cheapest agentic affordance you can ship, and almost nobody is doing it.

If you're a language designer, the bet to watch isn't whether agents will use your language. It's whether your *toolchain output* is something an agent can act on without an LLM round-trip. Zero is the loudest argument so far that the answer should be yes.

---

### Sources

- [vercel-labs/zero on GitHub](https://github.com/vercel-labs/zero)
- [Chris Tate's launch tweet](https://x.com/ctatedev/status/2055434061322039377)
- [MarkTechPost: Vercel Labs Introduces Zero](https://www.marktechpost.com/2026/05/17/vercel-labs-introduces-zero-a-systems-programming-language-designed-so-ai-agents-can-read-repair-and-ship-native-programs/)
- [TechTimes: Vercel Labs' Zero Compiler Speaks JSON to AI Agents](https://www.techtimes.com/articles/316793/20260518/vercel-labs-zero-compiler-speaks-json-ai-agents-closing-human-translation-gap-agentic-coding.htm)
- [The Stack: Vercel soft-launches machine-friendly language Zero](https://www.thestack.technology/next-js-creators-vercel-launch-ai-language-zero/)
- [Firethering: Vercel Built a Programming Language for AI Agents](https://firethering.com/vercel-zero-programming-language-ai-agents/)
- [Mervin Praison: Zero language — agent-first diagnostics and explicit effects](https://mer.vin/2026/05/zero-language-vercel-labs-agent-first-diagnostics-and-explicit-effects/)
- [Yeamt: Vercel engineer built Zero (includes Mehul Mohan reaction)](https://yeamt.com/vercel-zero-programming-language-for-ai-agents/)
- [byteiota: Vercel's Zero — A Programming Language Built for AI Agents](https://byteiota.com/vercels-zero-a-programming-language-built-for-ai-agents/)
