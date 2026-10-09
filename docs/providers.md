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
run(endpoint, kind, input, signal, onProgress, hooks?): Promise<ProviderOutput>
```

- `ProviderProgress` — status text pushed to the queue checklist and the log.
- `ProviderFile` — one output, with `width` / `height` (used to pick the highest
  resolution when a response returns extras) and `inlineText` for text payloads.
- `ProviderRunHooks` — notably `onSubmitted(requestId)`, which persists the pending
  record *before* the result is awaited. That is the orphan-recovery hook.
- `kind` is the node's output kind, and is **required** even though only bytedance
  reads it. Optional would compile at every call site while silently mis-routing one
  of them; required turns that into a typecheck failure.

## 2. The four providers

**fal** (`fal.ts`) — `@fal-ai/client`, queue-based with progress events, and reports a
live cost estimate that gets stamped into the sidecar on success.

> `FAL_KEY` is also what powers **LLM prompt enhancement**, so it is worth setting
> even if fal is not your generation provider.

**replicate** (`replicate.ts`) — `replicate` SDK, prediction polling.

**bytedance** (`bytedance.ts`) — **three API surfaces behind one `Provider`**, two of
them on Ark and one a different BytePlus product entirely:

| | Ark tasks | Ark images | VOD AI MediaKit |
|---|---|---|---|
| What | Seedance video | Seedream images | video enhancement |
| Shape | async: submit, poll, cancel | synchronous, one request | async: submit, poll |
| Body | `content[]`-wrapped | flat | flat |
| Key | `BYTEDANCE_API_KEY` | `BYTEDANCE_API_KEY` | `BYTEDANCE_MEDIAKIT_API_KEY` |
| Selected by | anything else | node `kind === "image"` | the `"mediakit-enhance-video"` sentinel |

MediaKit is checked first, on its endpoint sentinel — its node is `video` like
Seedance, so `kind` cannot separate those two. The **Ark** split then keys on the
node's `kind` rather than on the endpoint string, because Ark takes a published model
id or a provisioned `ep-…` endpoint id interchangeably in the same `model` field, and
an admin can swap one for the other (§3a). A hardcoded list of image-model ids used to
do this job and would miss every such override — posting an image job to the video task
API, which fails in a way that looks nothing like the cause.

Each surface has its own base URL, terminal-status set and request shape. Uploads for
all of them go through TOS (`tos.ts`), because Ark will not accept inline data.

### The private asset library (`ark-asset-create`)

A fourth surface: Ark's **management** OpenAPI (`arkOpenApi.ts`), which registers a
character image in the account's private asset library ("Advanced Creation Rights").
Seedance 2.0 / 2.5 then accept it as `asset://<id>` wherever an image URL goes, which is
how a consistent virtual character gets past the face filters.

| | |
|---|---|
| Host | `ark.ap-southeast-1.byteplusapi.com`, `POST /?Action=…&Version=2024-01-01` |
| Auth | **IAM AK/SK**, OpenAPI V4 `HMAC-SHA256` signing (service `ark`) — *not* the Bearer key. Reuses `tos_ak`/`tos_sk`, so that IAM user needs Ark asset permissions |
| Errors | `ResponseMetadata.Error`, returned with **HTTP 200** — check it, not just `res.ok` |
| Selected by | the `"ark-asset-create"` sentinel (its node is `image` like Seedream) |
| Node | `models/bytedance/asset-library.json` → ByteDance › Utility › Asset Library |

What a run does:

1. The source refs go to TOS as usual. `CreateAsset` takes a public https `URL`, not
   bytes.
2. The **first prompt line names the group**: one group per character.
   `ListAssetGroups`/`CreateAssetGroup` finds it or creates it.
3. **Every source image** (untagged images sweep into `source`, up to 30) gets a
   `CreateAsset` named `<group>_01`, `_02`, …
4. All of them are polled with `GetAsset` until `Active`.

Each output is the registered image itself, written to the version folder with its own
`arkAssetId` in its sidecar (`ProviderFile.arkAssetId`, so it is per file, not per job).
An image that is rejected (`Failed`) or never goes Active is logged and skipped, and the
job only throws when *none* registered. The others already hold library slots, and
throwing would orphan them with no gallery file.

- **Explicit on purpose.** Library capacity and `CreateAsset` rate are tier-limited and
  shared with the real-human library, so nothing is ever registered implicitly.
- **Throttling is retried.** `CreateAsset` is capped at 3/min (Entry), 120 (Advanced)
  and 300 (Premium). An `ArkApiError` with `isThrottled` waits 21 s and retries, up to 6
  times, so a large batch on the Entry tier takes minutes, not seconds.
- **Not cancellable once created.** Abort stops the wait; the asset stays. Delete it in
  the BytePlus console. There is no list/delete UI in aiSLAP.
- **`GetAsset`'s `URL` is a temporary signed link.** It is stripped before the response
  reaches `providerResponse`.
- **Images only, AIGC groups only.** Real-human (`LivenessFace`) groups need an H5
  liveness flow that isn't implemented. Video/audio assets exist in the API but are
  unverified.
- The Ark project comes from Settings (`Config.arkAssets.projectName`) → shared
  `ark_project_name` → `ARK_ASSET_DEFAULTS` (`default`). There is no group setting,
  because the prompt names the group.

How the id is consumed is in [generation-pipeline.md](generation-pipeline.md) §4.

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

## 3a. Shared config (multi-user/studio deployment)

Every field above (and `ffmpeg_path`, `max_concurrent_jobs`, `filename_template`,
`fal_lifecycle`, the TOS bucket/region/endpoint/ref-expiry, `colors`) can also be
supplied by a **read-only YAML file** on a network share, so a studio can roll out
one file instead of pasting secrets into every machine. Point each machine at it once
via Settings → General → "Shared config file" (`Config.sharedConfigPath`). aiSLAP
never writes to this file — it is purely admin-authored.

Precedence is always **local override → shared file → hard-coded default**, resolved
at each field's point of use (never inside `config_load()`, which stays pure local
truth — see `commands/config.rs::load_shared_config`). Secrets are keyed by their
existing env-var name (`fal_key`, `turso_database_url`, …); everything else is a new
snake_case key matching the `Config` field. Every field in Settings shows a mouseover
hint naming its key, and highlights when its value is inherited rather than typed
locally.

The same file can also carry a `models:` section, keyed throughout against
`"<provider>/<node.id>"`. It is YAML-only: aiSLAP never writes it, and there is
deliberately no Settings UI for any of it.

- **`include`/`exclude`** — glob lists (default `include: ["*"]`) that lock out models
  or whole providers org-wide. See `commands/models.rs::model_visible`.
- **`endpoints`** — pattern → replacement endpoint, for pointing a shipped model at a
  private endpoint id. See [model-registry.md](model-registry.md) §9b.

> **`endpoints` is not safe to point at an arbitrary string on every provider.** Three
> providers read the endpoint as something other than an opaque route:
>
> - **beeble** derives `generation_type` from it and **throws** on anything that is not
>   `switchx-image` or `switchx-video` (`beeble.ts`'s `ENDPOINT_GENERATION_TYPE`).
> - **replicate** parses it as `owner/model[:version]` and throws without the `/`.
> - **bytedance**'s `mediakit-enhance-video` and `ark-asset-create` are *routing
>   sentinels*, not real endpoints — they select the AI MediaKit and asset-library
>   halves of the provider. Remapping either sends the job to Ark instead.
>
> Ark's Seedance/Seedream endpoints are the intended use: Ark accepts a published model
> id or a provisioned `ep-…` endpoint id in the same `model` field, interchangeably.

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
