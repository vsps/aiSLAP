# Providers

All provider knowledge lives in TypeScript, under `src/lib/providers/`. The Rust
backend treats `provider` as an opaque string and needs no change to support a new
one.

---

## 1. The `Provider` interface

`providers/provider.ts` defines the contract; `providers/index.ts` is the registry
and caches one instance per name (an unknown or absent name resolves to `"fal"`).

```ts
prepare()                      // one-time setup, e.g. configure the SDK client
uploadFile(path): Promise<url> // make a local file reachable by the API
run(input, hooks): Promise<ProviderOutput>
```

- `ProviderProgress` — status text pushed to the queue checklist and the log.
- `ProviderFile` — one output, with `width` / `height` (used to pick the highest
  resolution when a response returns extras) and `inlineText` for text payloads.
- `ProviderRunHooks` — notably `onSubmitted(requestId)`, which persists the pending
  record *before* the result is awaited. That is the orphan-recovery hook.

## 2. The four providers

**fal** (`fal.ts`) — `@fal-ai/client`, queue-based with progress events, and reports a
live cost estimate that gets stamped into the sidecar on success.

> `FAL_KEY` is also what powers **LLM prompt enhancement**, so it is worth setting
> even if fal is not your generation provider.

**replicate** (`replicate.ts`) — `replicate` SDK, prediction polling.

**bytedance** (`bytedance.ts`) — **two unrelated BytePlus APIs behind one `Provider`**:

| | Ark | VOD AI MediaKit |
|---|---|---|
| What | Seedance / Seedream generation | video enhancement |
| Key | `BYTEDANCE_API_KEY` | `BYTEDANCE_MEDIAKIT_API_KEY` |
| Selected by | anything else | the `"mediakit-enhance-video"` endpoint sentinel |

`run()` dispatches on that sentinel; each half has its own base URL, terminal-status
set and request shape. Uploads for both go through TOS (`tos.ts`), because Ark will
not accept inline data.

**beeble** (`beeble.ts`) — [Beeble](https://developer.beeble.ai/docs)'s SwitchX
relighting / background replacement. The simplest of the four: `x-api-key` auth, one
submit endpoint and one status endpoint, and presigned-PUT uploads that need no
object store of their own (`POST /v1/uploads` → PUT the bytes → pass the returned
`beeble://` URI).

Two things about it are worth knowing:

- **`generation_type` comes from the node's `endpoint`**, not from a parameter —
  `switchx-video` and `switchx-image`. A video source cannot produce a still, and the
  model file's `outputs` already has to agree for `kind` inference to route the result
  to the right viewer.
- **It reports no cost.** The generation response carries no price (Beeble bills in
  credits off-API), so outputs land with `costUsd` absent and the project rollup
  counts them under `unknownImageCount`. Inventing a dollar figure from a credit
  count would be worse than saying nothing.

It also only returns `output.render` as a gallery item. The response's `source`
(preprocessed input) and `alpha` (extracted matte) URLs are diagnostic, so they stay
in the sidecar's `providerResponse` rather than adding two more tiles per generation
— note those signed URLs expire after 72h.

## 3. Key naming

`provider_key_get`/`set` take a logical name; `config.rs::env_var_for` maps it to the
environment variable written into `%APPDATA%/aiSLAP/.env`:

| Logical name | Environment variable |
|---|---|
| `fal` | `FAL_KEY` |
| `replicate` | `REPLICATE_API_TOKEN` |
| `beeble` | `BEEBLE_API_KEY` (via the fallback row below) |
| `turso_url` | `TURSO_DATABASE_URL` |
| `turso_token` | `TURSO_AUTH_TOKEN` |
| `tos_ak` | `TOS_ACCESS_KEY_ID` |
| `tos_sk` | `TOS_SECRET_ACCESS_KEY` |
| *anything else* | `<UPPERCASE>_API_KEY` |

That last row is why a new provider needs no Rust change — and also why
`BYTEDANCE_MEDIAKIT_API_KEY` existed for a long time without being declared anywhere:
it is *derived* from the logical name `bytedance_mediakit`, never written down. It is
now in `.env.example`.

## 4. Adding a provider

Seven steps, all TypeScript:

1. **`src/lib/providers/<name>.ts`** — implement `Provider`. `prepare` configures the
   client, `uploadFile` makes a local path reachable, `run` submits and polls.
2. **`providers/provider.ts`** — add the name to the `ProviderName` union.
3. **`providers/index.ts`** — add it to the `getProvider` registry.
4. **`src/lib/types.ts`** — widen the provider unions (`ModelNode.provider`,
   `ImageMetadata.provider`, `PendingSubmission.provider` / `.modelProvider`).
5. **`src/lib/generation/runner.ts`** — `buildPendingRecord`'s provider resolution.
6. **`src/components/SettingsDialog.tsx`** — a key field, and
   **`src/components/ModelPicker.tsx`** — a provider tab.
7. **`models/<name>/*.json`** — the model definitions. See
   [model-registry.md](model-registry.md).

Plus, if the API needs a ref slot no existing role covers, a new `RoleAssignment`
member — `types.ts`, `RoleMenu.tsx`, `roleColor`/`roleLabel` in
`RefImagesColumn.tsx`, `EDGE_COLORS` in `TraceView.tsx`. Beeble needed two (`alpha`,
`reference`); see [model-registry.md](model-registry.md) §6.

No Rust, no key plumbing: `env_var_for`'s fallback already covers the new name.

> **Two of those steps fail silently if skipped.** `runner.ts` coerces an unrecognised
> provider to `"fal"` rather than erroring, and `domain.rs` types `provider` as
> `Option<String>` so Rust will not complain either. A missed step shows up at runtime
> as generations going to the wrong API, not as a build failure.

Orphan recovery is the deliberate exception: `recovery.ts` has real logic only for
fal, and a new provider falls into the existing "still running / not implemented"
branch. That is expected — see [generation-pipeline.md](generation-pipeline.md) §11.
