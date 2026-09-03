# aiSLAP documentation

aiSLAP 0.3.9 — a desktop GUI (Tauri v2: React 19 + Rust) for generative image and
video APIs, organised around a project / sequence / shot file layout. Everything
saves straight to disk with a metadata sidecar.

## Start here

Read in this order:

1. **[architecture.md](architecture.md)** — the layers, the three rules everything
   else follows from, and the invariant checklist. Start here even for a small change.
2. **[generation-pipeline.md](generation-pipeline.md)** — what happens between
   pressing Run and a file appearing in the gallery.
3. Then whichever topic you are about to touch.

## Map

| File | Read it when you're about to… |
|---|---|
| [architecture.md](architecture.md) | change anything — it carries the invariants |
| [generation-pipeline.md](generation-pipeline.md) | touch prompts, refs, dispatch, or output writing |
| [model-registry.md](model-registry.md) | **add or edit a model** — this is the most common change |
| [providers.md](providers.md) | add an API provider, or debug key handling |
| [tabs.md](tabs.md) | touch per-tab state, the job queue, or app-state persistence |
| [storage.md](storage.md) | touch paths, sidecars, asset identity, or the SQLite index |
| [prism.md](prism.md) | touch anything path-shaped in a PRISM project |
| [tags.md](tags.md) | touch tagging, filtering, or the tag view |
| [styling.md](styling.md) | add a button, toggle, tag chip, or colour token |
| [timeline.md](timeline.md) | touch the timeline strip, playback, or either export path |
| [model.schema.json](model.schema.json) | (not prose — point your editor at it from a model file) |

End-user walkthroughs live in **[guides/](guides/)**.

## How these docs are written

Four rules. They exist because the previous documentation went stale within one
release cycle, and because a doc that contradicts the code is worse than no doc.

1. **One fact, one home.** Every claim lives in exactly one file; the others link to
   it. This is the only real defence against two documents drifting apart.
2. **Cite paths and symbol names, never line numbers.** `args.ts` →
   `splitNegativePrompt()`, not `args.ts:40`. Line numbers rot within a single commit.
3. **Document contracts and invariants, not file inventories.** Several of the large
   modules are split candidates. A doc organised around *what must stay true* survives
   a refactor; one organised around *which file holds what* does not.
4. **Mark status explicitly.** A reader cannot tell a deliberate limitation from a bug
   without being told, so say which it is:
   - **deliberate** — a decision. Don't "fix" it without changing the decision.
   - **known gap** — a real shortcoming, not yet addressed.

`architecture.md` §9 carries the current list of both.

## Keeping them true

If you change tags, PRISM paths, the model JSON shape, the provider interface, the DB
schema, the generation pipeline, or the colour tokens and control primitives,
**update the matching file in the same PR**. The
whole set is small enough to re-read in one sitting; keep it that way.
