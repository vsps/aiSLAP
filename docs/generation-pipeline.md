# The generation pipeline

What happens between pressing Run and a file appearing in the gallery. This spans
five modules and is the spine of the app.

```mermaid
sequenceDiagram
    participant U as RunColumn
    participant E as enqueue.ts
    participant R as runner.ts
    participant A as args.ts
    participant P as Provider
    participant O as output.ts
    participant RS as Rust
    U->>E: submit (link, or whole chain)
    E->>E: preflightChain · snapshot JobSpecs
    E->>R: registerJob · pumpQueue
    R->>RS: upload refs (provider.uploadFile)
    R->>A: settings + uploaded refs -> input object
    R->>P: prepare() then run()
    P-->>R: onSubmitted(requestId) — persisted before awaiting
    P-->>R: onProgress · final ProviderOutput
    R->>O: downloadAndWrite
    O->>RS: download · write sidecar · index · outbox
    O->>U: rescan shot -> gallery updates
```

---

## 1. Model selection

`ModelPicker` chooses a provider tab, then a family, then a node; the node goes into
`generationStore` as the active link's `model`. `SettingsPanel` renders one control
per entry in the node's `parameters`, seeded from each parameter's `default`.

## 2. Enqueue

`enqueue.ts` **snapshots** the form into one or more `JobSpec`s — a single link, or
every link when running a chain. Snapshotting matters: the user can keep editing while
a job runs, and the job must use the values as they were at submit.

`preflightChain` (`chainValidation.ts`) gates the submit and reports what is missing
rather than failing mid-run. Then `registerJob` + `pumpQueue` run jobs up to
`DEFAULT_MAX_CONCURRENT_JOBS`. `iterations` repeats the whole spec N times, tracked as
`currentIteration`; `QueueChecklist` renders the result live.

## 3. Prompt assembly

`prompts.ts` → `buildCombinedForLink` concatenates, in order and each behind its own
inclusion flag:

- the sequence script segment and the shot script segment (from `scriptStore`, matched
  by heading)
- the sequence prompt (`sequencePromptIncluded`)
- each shot prompt block (`shotPromptsIncluded[]`)

Pieces are trimmed, empties dropped, and joined with blank lines.

> **PRISM subtlety.** Script headings are matched against *entity* names via
> `seqShotNames`. A PRISM shot path ends in `Renders/AI`, so matching on the path's
> last segments would compare against `"AI"` and never hit.

## 4. References

A ref carries a `RoleAssignment`, one of:

`source` · `start` · `end` · `mesh` · `element` · `image` · `chain_prev`

- Refs are numbered by position within their row, which is what `@ElementN` and
  `@ImageN` in a prompt refer to.
- `element` groups are *named*, and one member can be flagged frontal.
- `image` pins a ref to a specific slot in an array input.
- `chain_prev` is synthesised at chain-run time from the previous link's output.

Upload goes through `provider.uploadFile`. ByteDance uploads via TOS (`providers/tos.ts`)
because Ark will not accept inline data.

## 5. `args.ts` — settings + refs → the provider input object

Two rules do most of the work here.

**Role routing, with fallthrough.** Each `ref_roles` entry claims refs of its role and
places them at its `api_field`. Refs that **no declared role claims** fall through to
`routeRefsByMediaType`, which places them by media type. This is why a model can name
only *some* of its ref inputs — Seedance's ref2vid node declares just the `image` role
and lets video and audio route themselves.

**The `---` negative-prompt split.** There is no negative-prompt box in the settings
panel. Instead `splitNegativePrompt` looks for a run of three or more dashes anywhere
in the combined prompt: everything before it is the prompt, everything after is the
negative prompt. It is routed **only** when the model declares a `negative_prompt`
parameter (`negativePromptParam`); otherwise the text stays part of the prompt.

This is user-facing behaviour with no UI affordance — it is documented in the README
and the guides for that reason, and it is why several model files declare
`negative_prompt` as a single-option enum (see
[model-registry.md](model-registry.md) §7).

One deliberate exception: some models treat `prompt` as something other than a story
prompt — SAM 3 uses it as a concept filter — so the combined prompt is not leaked into
those inputs.

## 6. Dispatch

`runner.ts` owns the private `jobSpecs` and `abortControllers` maps. `getProvider(name)`
returns a cached provider instance; `prepare()` then `run()` with an `onProgress`
callback.

`hooks.onSubmitted(requestId)` is the **orphan-recovery hook**: the pending record is
written to `pending.json` *before* the result is awaited, so a crash mid-flight leaves
a trail. See §11.

## 7. Output

`output.ts` → `downloadAndWrite`:

- **Filename** from the template, default
  `<date>_<time>_<sequence>_<shot>_<model>_<version>_<minor>`, with `_1`…`_N` appended
  for a batch and an iteration suffix when iterating.
- **`<minor>`** is a 3-digit ordinal that counts up *within one version column*, across
  generations. It is allocated from a monotonic counter in `shot.json`
  (`minorCounters`, keyed by version name) via `shot_version_minor_next` — **not** read
  back off existing filenames. Two reasons: the token can sit anywhere in a
  user-authored template, so parsing it back is guesswork; and the download path
  overwrites on collision rather than erroring, so a misparse destroys a file. Being a
  counter also means trashing a file never frees its number. Allocation is serialised by
  a mutex, because concurrent jobs can target the same column. Templates without the
  token skip the IPC entirely.
- **Version folder** resolved per project shape — `v001` natively, PRISM's configured
  padding otherwise.
- **Highest-resolution pick** when a response returns more files than were requested:
  width×height wins over array position, because "thinking" image models return a
  low-res preview alongside the final image.
- **`inlineText`** outputs (SAM 3 embeddings) are written to a `.txt` beside the media.
- **Sidecar** carries the prompt pieces, the exact `combinedPrompt` that was sent, the
  settings, a snapshot of the refs, the provider response, and `costUsd`.
- **Index** — the asset is upserted into SQLite and queued in the outbox.
- **Rescan** — the shot is rescanned so the gallery picks the file up.

> `output.ts` deliberately imports no stores. That is what lets the orphan-recovery
> driver reuse it outside a live session.

## 8. Chains

Links run in order. A link with `consumesPrev` gets a synthetic `chain_prev` ref
pointing at the previous link's output, and the sidecar records the lineage as a
`ChainMetadataBlock` — which is what `TraceView` later walks.

## 9. Cancellation, errors, trace

One `AbortController` per job. Failures go through `extractErrorMessage` to
`ErrorPopup` and `pushLog` → `LogWindow`. `TraceView` walks a file's reference
lineage backwards across the project (Escape exits; the status bar reads
`tracing · N images`).

## 10. Cost

fal reports a live estimate that is stamped into the sidecar on success. For other
providers, and for backfill, `pricing.rs` mirrors `falPrices.ts` and
`project_cost_scan` rolls costs up per shot, sequence and project — writing `costUsd`
back into sidecars that lack it.

## 11. Orphan recovery

`recovery.ts` reads `pending.json` at boot and reconciles anything that was in flight
when the app died.

> **Deliberately fal-only.** fal is the only provider that returns a durable request
> id at submit time, so it is the only one whose in-flight job can be re-attached. The
> others fall into a documented "still running / not implemented" branch. This is a
> decision, not an oversight.
