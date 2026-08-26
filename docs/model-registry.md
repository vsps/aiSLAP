# Model registry

Every model aiSLAP can run is declared as JSON under `models/`. Adding a model is
the most common change to this repo and needs no code — but the loader is lenient in
ways that are easy to trip over, and **a malformed file fails silently**: the model
simply is not in the picker, and the only signal is the `models: N` count in the
status bar.

That is what this document and `model.schema.json` exist to prevent.

---

## 1. What the registry is

- 28 files under `models/<provider>/`, **one family per file**.
- Loaded once, at boot, by the `models_load` command (`src-tauri/src/commands/models.rs`).
- Flattened into `ModelEntry { family, category, node }` — one entry per *node*.
- Surfaced by `ModelPicker` (provider tabs → family select → node select) and counted
  in the status bar.

**There is no hot reload.** Editing a model file requires restarting `pnpm tauri dev`.

Point your editor at the schema by putting this on line 2 of any model file:

```json
"$schema": "../../docs/model.schema.json"
```

The loader ignores unknown keys, so this is inert at runtime.

---

## 2. File level

| Field | Type | Required | Notes |
|---|---|---|---|
| `provider` | string | no | Inherited by every node unless the node overrides it. Absent everywhere → `"fal"` at dispatch. |
| `family` | string | in practice | Groups nodes in the picker. |
| `category` | string | in practice | Picker heading, e.g. `"fal.ai/Video Generation"`. |
| `nodes` | array | yes | One entry per endpoint or mode. |

`family` and `category` are `#[serde(default)]`, so a file omitting them **loads
fine** and produces unlabelled picker entries. That is a silent misbehaviour rather
than an error — the test in `models.rs` rejects it.

---

## 3. Node level

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | **yes** | Stable identity; persisted in `app-state.json` and sidecars. Must be unique. |
| `name` | string | **yes** | Shown in the picker. |
| `endpoint` | string | **yes** | Passed to the provider verbatim. |
| `inputs` | array | no | See §4. |
| `outputs` | array | no | See §5 — this drives `kind` inference. |
| `ref_roles` | array | no | See §6. |
| `parameters` | array | no | See §7. |
| `kind` | string | no | Inferred; see §8. |
| `batch_field` | string | no | Inferred; see §8. |
| `provider` | string | no | Overrides the file-level provider. |

> **`id`, `name` and `endpoint` have no default.** A node missing any one of them
> fails deserialization — and because they deserialize as a unit, that takes **the
> whole file's nodes** with it, not just the bad node. This is the single most common
> way to make a whole family disappear.

---

## 4. `ModelInput`

Declares what the model consumes.

| Field | Type | Notes |
|---|---|---|
| `name` | string | Internal label. |
| `data_type` | `STRING` \| `IMAGE` \| `VIDEO` \| `AUDIO` | |
| `api_field` | string | The provider's field name. |
| `api_format` | `"array"` | Send as an array even for one item. |
| `required` | bool | |
| `max` | int | Upper bound on how many. |

---

## 5. `ModelOutput`

| Field | Type | Notes |
|---|---|---|
| `name` | string | Internal label. |
| `data_type` | `IMAGE` \| `VIDEO` \| `MODEL_3D` | |
| `api_field` | string | Where to find it in the response. |

**Outputs carry more weight per character than anything else in the file**, because
`kind` is inferred from them (§8). A 3D model that forgets to declare a `MODEL_3D`
output renders as a flat image and never opens the GLB viewer.

---

## 6. `RefRoleSpec`

Maps a user-assigned reference role onto a provider field.

| Field | Type | Notes |
|---|---|---|
| `role` | string | Free-form *to the loader*, but see below. In practice `source`, `start`, `end`, `element`, `image`, `mesh`, `alpha`, `reference`. |
| `api_field` | string | Where the uploaded URL goes. |
| `max` | int | How many refs this role accepts. |
| `exclusive` | bool | Only one ref may hold it. Auto-set for `start`/`end`. |
| `named` | bool | Refs group under a name (`@ElementN`). Auto-set for `element`. |

**A model does not have to name all of its ref inputs.** Refs that no declared role
claims fall through to `routeRefsByMediaType` in `args.ts`, which places them by
media type. This is why Seedance's ref2vid node declares only the `image` role and
lets video and audio route themselves.

**A role name the UI doesn't know is unassignable.** The loader accepts any string,
but the user can only pick a role that `RoleMenu.tsx`'s `rolesSupportedBy` lists, and
`RoleAssignment` in `types.ts` is a closed union. Inventing a role name in a model
file gives you a role nobody can select — which then only fills via the untagged
fallback, if it has one. Adding a genuinely new role means touching both of those
plus `roleColor`/`roleLabel` in `RefImagesColumn.tsx` and `EDGE_COLORS` in
`TraceView.tsx`.

**Only `source` sweeps up untagged refs.** `selectForRole` falls back to unassigned
refs of the role's media kind for `source` alone; `image`/`element` collect untagged
refs of their kind through their own group logic. Every other role — `alpha`,
`reference`, `mesh`, `start`, `end` — is explicit-assignment-only. That is why
Beeble's SwitchX uses `reference` rather than `image` for its style input: on the
image node the source and the reference are both stills, and `image`'s untagged sweep
would hand the same file to both slots.

---

## 7. `parameters`

A discriminated union on `type`. Everything here becomes a control in
`ModelSettingsColumn`.

```jsonc
// enum — a dropdown
{ "name": "resolution", "label": "Resolution", "type": "enum",
  "api_field": "resolution", "default": "1080p", "options": ["720p", "1080p"] }

// int — seeds conventionally use -1 to mean "random"
{ "name": "seed", "label": "Seed", "type": "int",
  "api_field": "seed", "default": -1, "min": -1, "max": 2147483647 }

// float
{ "name": "guidance", "label": "Guidance", "type": "float",
  "api_field": "guidance_scale", "default": 3.5, "min": 0, "max": 20, "step": 0.1 }

// bool
{ "name": "generate_audio", "label": "Audio", "type": "bool",
  "api_field": "generate_audio", "default": true }

// prompts — the SAM point/box geometry editor
{ "name": "prompts", "label": "Prompts", "type": "prompts", "api_field": "prompts" }
```

Two idioms worth knowing, because both look like mistakes:

**The empty-enum negative prompt.** Several fal models declare:

```json
{ "name": "negative_prompt", "type": "enum", "api_field": "negative_prompt",
  "default": "", "options": [""] }
```

A dropdown with one blank option is not a useful control — and it is not meant to be.
It exists so `negativePromptParam` can *find* the field. The value actually arrives
from the `---` split in the prompt box (see
[generation-pipeline.md](generation-pipeline.md)). If you drop this declaration, the
negative prompt is silently never sent.

**`prompts` bypasses `api_field`.** The SAM editor writes `point_prompts` and
`box_prompts` straight into the settings object; the declared `api_field` is nominal.

---

## 8. Inference — what the loader does that no file says

These three rules are why the shipped files are as short as they are, and why
copying one without understanding them goes wrong.

### `kind`

Declared wins. Otherwise:

1. any `MODEL_3D` output → `model3d`
2. else any `VIDEO` output → `video`
3. else → `image`

**All 28 shipped files omit `kind`.** Every model in the repo depends on this
inference, which a test asserts — if you start declaring `kind`, that test fails and
tells you to update this document.

### `batch_field`

Declared wins. Otherwise the first parameter whose `api_field` is one of
`num_images`, `num_samples`, `n`, `batch_size`.

A batch parameter named anything else is silently *not* a batch field, and the
iteration count will not reach the API. Declare `batch_field` explicitly in that case.

### `ref_roles` annotation

- `role: "start"` or `"end"` with no `exclusive` → `exclusive: true`
- `role: "element"` with no `named` → `named: true`

Set the field explicitly to opt out.

---

## 9. Discovery

`collect_model_files` reads:

- top-level `models/*.json`, **plus**
- exactly **one** directory level deep — `models/<provider>/*.json`

Entries whose name starts with `.` are skipped. Both levels are sorted by name, which
is what makes picker order stable.

**Deeper nesting is silently ignored.** `models/fal/video/veo3.json` will never load.

---

## 10. Failure modes

| What went wrong | What you observe |
|---|---|
| File unreadable | Model missing from the picker; `models: N` one lower |
| JSON syntax error | Same |
| Node missing `id` / `name` / `endpoint` | **The whole file's nodes vanish** |
| Wrong `data_type` on an output | Model loads but behaves as the wrong kind |
| Batch param with an unrecognised `api_field` | Iterations silently not sent |
| Unknown extra key | Ignored — safe, but a typo'd field name is invisible |
| `models/` not found at all | Boot error, `models: 0` |

Two guards exist:

- **Author time** — `docs/model.schema.json`, honoured natively by VS Code.
- **Merge time** — `models::tests::every_shipped_model_file_parses_and_declares_nodes`
  walks the real `models/` directory and asserts every file parses, declares nodes,
  has a non-empty family and category, and has unique non-empty node ids. This runs
  in CI. It is the stronger of the two.

When editing by hand, note the `models: N` count before and after.

---

## 11. Distribution

`tauri.conf.json` ships the directory as a bundle resource:

```json
"resources": { "../models/": "models/" }
```

`paths::models_dir` resolves it differently per context:

- **dev** — the repo copy, found relative to the working directory, so edits are
  picked up on restart without a rebuild
- **packaged** — the bundle resource: next to the binary on Windows,
  `<app>.app/Contents/Resources/` on macOS, `/usr/lib/<app>/` on Linux

A Finder-launched `.app` gets `/` as its working directory, which is why the dev
candidates cannot stand in for the resource lookup.

---

## 12. Worked example — a new model

`models/fal/my-model.json`:

```json
{
  "$schema": "../../docs/model.schema.json",
  "provider": "fal",
  "family": "MyModel",
  "category": "fal.ai/Image Generation",
  "nodes": [
    {
      "id": "mymodel_img2img",
      "name": "MyModel (img2img)",
      "endpoint": "fal-ai/my-model/image-to-image",
      "inputs": [
        { "name": "prompt", "data_type": "STRING", "api_field": "prompt", "required": true },
        { "name": "image", "data_type": "IMAGE", "api_field": "image_url" }
      ],
      "outputs": [
        { "name": "image", "data_type": "IMAGE", "api_field": "images" }
      ],
      "ref_roles": [
        { "role": "source", "api_field": "image_url", "max": 1 }
      ],
      "parameters": [
        { "name": "num_images", "label": "Batch", "type": "int",
          "api_field": "num_images", "default": 1, "min": 1, "max": 4 },
        { "name": "negative_prompt", "label": "Neg Prompt", "type": "enum",
          "api_field": "negative_prompt", "default": "", "options": [""] },
        { "name": "seed", "label": "Seed", "type": "int",
          "api_field": "seed", "default": -1, "min": -1, "max": 2147483647 }
      ]
    }
  ]
}
```

No `kind` (inferred `image` from the `IMAGE` output). No `batch_field` (inferred from
`num_images`). `source` gets no automatic annotation, which is correct.

Then:

1. Restart `pnpm tauri dev`.
2. Check `models: N` went up by the number of nodes.
3. Find it in `ModelPicker` under its family and category.
4. Generate once, then open the sidecar and confirm `settings` match what you declared.
5. If cost matters, add a manual price override in Settings — fal endpoints are
   otherwise priced from the fetched price table.

## 13. Worked example — a node on an existing family

The commoner case: a new mode of a model you already ship. Append to `nodes` in the
existing file, with a new unique `id`, the new `endpoint`, and whichever `ref_roles`
the mode takes. Nothing else changes — the family and category are already right, and
the picker will show it alongside its siblings.

`models/fal/veo3.json` is the reference example: four nodes (txt2vid, img2vid,
Veo3.1 img2vid, Veo3.1 first+last-frame) differing only in endpoint and ref roles.
