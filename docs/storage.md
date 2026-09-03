# Storage

Where everything lives on disk, and which parts are authoritative.

```mermaid
graph LR
    G[Generation] -->|1| M[("media + .json sidecar<br/>durable")]
    M -->|2 best-effort| DB[("SQLite index<br/>%APPDATA%")]
    DB -->|3 queued| OB[("outbox")]
    OB -.->|4 optional, on demand| T[("Turso")]
    M -.->|rebuild any time| DB
```

Step 1 is the commit. Everything after it is derived, and can be rebuilt from step 1
by `project_tags_reindex` or `project_reconcile`.

---

## App-level paths

`%APPDATA%\aiSLAP\` (`paths.rs`):

| File | Contents |
|---|---|
| `.env` | provider keys — see [providers.md](providers.md) §3 |
| `config.json` | ffmpeg path, colours, cached fal prices, price overrides, TOS config |
| `app-state.json` | last session: project/sequence/shot, chain links, iterations |
| `presets.json` | saved chain presets |
| `pending.json` | in-flight submissions, for orphan recovery |
| `db/<project-id>.db` | the local SQLite index, one file per project |

Plus `models_dir`, which is *resolved* rather than assumed — see
[model-registry.md](model-registry.md) §11.

## Project layout

**Native:**

```
project/
  project.json           project id, title, tagDefs, tagsMigrated, version prefix
  script.md              optional
  .aislap/thumbs/        gallery thumbnail cache — derived, see below
  SRC/                   project-wide inputs
  TRASH/                 trashed media — see below
  <sequence>/
    sequence.json
    <shot>/
      shot.json          prompt history, version selects, minor counters, clip media
      SRC/               shot inputs
      SEL/               legacy — see below
      v001/ gen001/ …    one folder per generation batch
```

**PRISM:** the same, except the shot level is `<entity>/Renders/2dRender/AI`. See
[prism.md](prism.md).

> **`SEL/` is deliberate legacy.** It still renders as a gallery column where it
> exists, but nothing is ever moved into one — its role was replaced by the `select`
> tag. Every directory scan treats `SRC`, `SEL` and `.`/`$`-prefixed names as
> non-version folders.

## The media pair

```
clip.mp4            the media
clip.json           its sidecar — the durable record
```

These move as a unit through copy, move, rename, **trash** and **export**. `fsutil.rs`
provides `sidecar_path` (plus the legacy thumbnail helpers below) so no caller has to
rebuild those names by hand — the export path silently dropped thumbnails for exactly
that reason before the helpers existed.

## The thumbnail cache

Every gallery tile renders a small cached derivative, not the media itself:

```
<project>/.aislap/thumbs/<sha256(rel_path, mtime_ms, len)>.jpg
```

One flat directory per project. `commands/thumbs.rs` owns it; `fsutil.rs` owns the
path/key helpers (`thumb_cache_dir`, `thumb_cache_key`, `thumb_cache_path`,
`thumb_stat`).

- **Spec:** long edge 1024px (never upscaled), JPEG q80, RGB8 with alpha composited
  onto black — which is what a tile renders against anyway. The widest a tile ever gets
  is 500 CSS px, so 1024 covers a 2× display.
- **Stills have one too.** This is the point of the whole thing. Before it, a still
  rendered its full-resolution original into an 80–500px tile: one real 8-column shot
  measured 110 stills / 208MB, over SMB, re-read on every gallery mount — and a tab
  switch remounts the gallery (`tabs.md` §3).
- **The key self-invalidates.** `mtime`+`len` are in it, so a file edited in place by
  another tool simply misses and gets re-encoded; there is no staleness to detect and no
  metadata stored alongside. The *relative* path is used so moving or re-mounting the
  whole project doesn't invalidate everything.
- **A move inside the project does change the key**, which is the cost of not being a
  sibling any more. `image.rs` therefore renames/copies the cache entry alongside the
  media (`thumbs::rename_cache_entry` / `copy_cache_entry`). A move made *outside*
  aiSLAP orphans an entry until the next full sweep prunes it — **known gap**, the same
  shape as the reconcile gap below.
- **`.aislap` is `.`-prefixed**, so `walk::is_content_dir` and `fsutil::list_dirs`
  already exclude it from every traversal. That is the *only* thing keeping the cache
  out of gallery scans, so the constant must keep that property — there is a test.
- **Membership is answered from memory.** `THUMB_INDEX` (a `OnceLock<Mutex<HashMap<…>>>`,
  same shape as `db::LOCAL_DBS`) holds each project's key set, filled by one `read_dir`
  per project per session. Stat-ing per file would add a few hundred SMB round trips to
  every rescan, and a rescan follows every generation iteration.

`thumbs_ensure(root, recursive, ffmpeg)` builds what's missing. Non-recursive sweeps a
shot's own folders (the frontend also sweeps `<project>/SRC`, which renders as the
GLOBAL SRC column but lives outside the shot); recursive walks the whole project **and
prunes** unclaimed entries and stale `.jpg.tmp` files. Every arm is an existence check
and every write is tmp-then-rename, so it is idempotent and safe to interrupt. Driven
from `src/lib/thumbs.ts`, which remembers which folders it has already swept this
session — without that, a read-only share would retry a doomed write on every rescan.

### Legacy sibling thumbnails

Projects made before the cache are full of these, and they are still **read**:

```
clip.thumb.jpg      poster frame, for video (8-bit JPEG)
clip.thumb.png      poster frame, for 3D — the provider's RGBA preview
```

- **`.thumb.png`** is what every project generated before the JPEG switch is full of, at
  ~8MB each: a 10-bit source (Seedance 2.5 returns HEVC Main 10 for some outputs) had
  ffmpeg emitting 16-bit `rgb48be` PNGs. A recursive sweep re-encodes these into the
  cache and deletes them — **except in a PRISM project, where aiSLAP never removes
  files**; there the PNG stays and is simply never read again.
- **3D previews keep their sibling `.thumb.png` permanently.** Those bytes are
  downloaded from the provider (Meshy ships an RGBA render, already ~130KB) and never
  re-encoded, because flattening them to JPEG would cost the transparency that is the
  point of them. `ThumbCtx::lookup` special-cases `is_model3d_ext` for this.

`existing_thumb_path` (prefers `.jpg`, falls back to `.png`, `None` for neither) is the
read path, and it is also the fallback `ThumbCtx::lookup` returns for media the sweep
hasn't reached yet. `thumb_path_like` keeps a legacy PNG a PNG when a move or rename
carries it, instead of relabelling its bytes. `THUMB_SUFFIXES` in `src/lib/media.ts`
mirrors the Rust list for the frontend's guess-the-sidecar paths — keep the two in step.

The sidecar carries the prompt pieces, the exact `combinedPrompt` sent, the settings,
a ref snapshot, the provider response, `costUsd`, the chain lineage, `tags`, `assetId`
and `contentHash`.

**Derived media.** The video trim (`video_trim` in `media.rs`, driven by `TrimMode`)
writes `<stem>_trim.mp4` beside its source and gives it a full pair plus a cached
thumbnail, so it is the first file aiSLAP creates with no generation behind it. Its
sidecar is cloned from the source's, minus three fields: `tags` (a trimmed copy of the `select`
take is not itself the selected take), `costUsd` (the trim is local work — inheriting
it would double-count the clip in `project_cost_scan`), and a fresh `assetId` +
`contentHash`, because two files must never share an identity. `refs` stays the
*original generation's* inputs so RESTORE PROMPT still reproduces the generation
rather than the edit; the link back to the source lives in **`derivedFrom`**
(`{ op, path, assetId, startSec, endSec }`).

## TRASH

**There is no hard delete.** `image_trash` moves the whole pair (and any legacy sibling
thumbnail) into `<project>/TRASH/`
under a mirror of the file's project-relative path — `TRASH/SQ01/sh010/v003/clip.mp4` —
so where it came from is legible and two shots' identically-named files can't collide.
A name trashed twice gets `_1`, `_2` … appended, applied to every companion at once so
the set stays a set (`CollisionPolicy::Uniquify` in `image.rs`). The cache entry is not
moved: its key changes with the path, so the next full sweep prunes it.

`TRASH` is excluded from every traversal, at **both** gates: `walk.rs::is_content_dir`
(which covers `project_walk`, `project_reconcile`, `project_cost_scan`, `timeline_init`
and `project_tag_scan`) and `fsutil.rs::list_dirs` (which fills the SEQUENCE dropdown).
Miss the second and a native project grows a `TRASH` sequence.

Trashing **purges** the file's index rows rather than relinking them — a row pointing
inside `TRASH` would never be revisited by reconcile yet would still answer tag queries.
Restoring is therefore just moving the file back out: `project_reconcile` re-ingests it
on the next project open and recovers its `assetId` from the embedded media id, and its
tags never left the sidecar.

**In a PRISM project nothing is trashed or deleted at all** — see [prism.md](prism.md).

## Asset identity

`media_id.rs` embeds an id **inside the media file** — EXIF UserComment for JPEG, a
text chunk for PNG, a private chunk for WebP, ffmpeg metadata for video — and mirrors
it, plus a content hash, into the sidecar. Embedding is best-effort: a format that
cannot carry one still gets an id in its sidecar.

- A **rename or move** keeps the id; `project_reconcile` relinks the index by it.
- A **copy** is deliberately re-identified with a fresh id (`reidentify_copy`), so two
  files never share one. Its tag rows are re-keyed to match.
- The **content hash** is streamed rather than read whole — this runs over every file
  in a project, and the media is routinely multi-gigabyte video.
- A sidecar that has **lost its `assetId`** gets the embedded one back rather than a
  fresh uuid. That is what embedding an id is *for*: minting a new one would orphan the
  existing index row and every tag on it. Reported as `identityRecovered`.

### Tracing a loose file

`db::trace::asset_trace` (AUDIT → File lookup) is the read-only counterpart: given a
media file that turned up *somewhere* — moved off the share, handed over by an editor,
with or without its sidecar — it answers which project, which generation and whose.

It is the one query in `db/` that is **deliberately not scoped to a project**, because
the premise is a file that may not belong to the one currently open: it walks every
`.db` in `%APPDATA%/aiSLAP/db` plus the remote, and reports which index each row came
from.

Three passes, in descending order of confidence:

| Pass | Key | Strength |
|---|---|---|
| 1 | sidecar `assetId`, then the id embedded in the media | proof |
| 2 | content hash — of the bytes *now*, not the sidecar's copy | proof, and deliberately unlimited: a copy keeps its source's bytes, so one hash legitimately matches several assets |
| 3 | file name | a guess — **only run when 1 and 2 matched nothing**, labelled `fileName` in the result so the UI can say so |

A sidecar hash that disagrees with the bytes is reported rather than hidden: it means
the file was edited in place, which is exactly the case reconcile no longer notices.

**`projects.root_path` is local-only.** Added by `ensure_column` in `local_db` and
written by `sync_outbox`, never by `upsert_project_row` — the remote `projects` table
must not carry it, since the same project is mounted at a different path on every
machine. It is what lets a match name a folder the user can open instead of a bare
project id, including for a row that only exists remotely: a project this machine has
opened resolves locally regardless of which index answered.

### What reconcile does, and what it deliberately misses

`project_reconcile` runs on every project open. It:

1. loads the whole index in two queries, rather than querying per file;
2. walks the project **off the async runtime** — a large project over SMB would
   otherwise pin a runtime worker for minutes;
3. decides per file, and applies every database change in **one transaction**.

**It does not re-hash a settled file.** A file that already carries both an `assetId`
and a `contentHash`, and is indexed at the path it actually sits at, is taken at its
word. Hashing everything on every open meant reading the entire project — often
gigabytes of video — to conclude "nothing changed", which it almost always had.

The trade: a file edited **in place** by another tool, keeping its path and its
sidecar, is no longer noticed. Anything that moves, is new, or has lost its identity
still is. `project_tags_reindex`, and deleting the index outright, both force a full
re-read.

## The SQLite index

Per project, under `%APPDATA%`, keyed by the project id. Tables: `assets`,
`asset_refs`, `asset_tags`, `outbox`, `projects` (plus `shot_state` and
`prompt_history`, created ahead of the feature that will use them).

It is a **cache**. Deleting it costs a reindex, not data.

**`projects` is the human-readable name for a `project_id`.** One row
(`project_id`, `title`, `updated_at`), refreshed by `sync_outbox` on every
call rather than queued through `outbox` — `outbox` is keyed by asset id, and
a title change has no asset to hang off. The title itself comes from
`commands::session::project_title_for`: a PRISM project's `pipeline.json`
`globals.project_name` when set, else the folder name — live-derived every
time, never trusted from the `title` stored in `project.json` at creation, so
a later pipeline.json edit doesn't go stale. This is what gives the remote
Turso database — genuinely multi-project, see below — a name to show next to
`project_id` in a cross-project report. The frontend derives the identical
value itself (`prism.projectName` from `prism_detect`, else the folder
basename) for the SessionBar label rather than round-tripping through a
command; keep the two derivations in lockstep if this rule ever changes.

Notes that are easy to get wrong:

- The local file is single-project, so `project_id` is a constant column in it. The
  local-only indexes (`SCHEMA_LOCAL`) therefore lead with `content_hash` / `rel_path`
  rather than `project_id`; the composite indexes in the shared schema are correct for
  the *remote* database, which genuinely holds many projects.
- **The remote `assets`/`asset_refs`/`asset_tags` are one shared table per name, not
  one per project.** Considered splitting by project when the `generated_by` index
  went in; rejected. SQLite's write lock and B-tree depth are functions of the
  *database*, not the table — more tables in the same Turso database buys no
  concurrency and no shallower lookups, and Turso bills rows read/written, not table
  count. A `project_id`-leading index already bounds a project's own queries to its own
  rows regardless of how large other projects grow. Splitting would also cost the one
  thing this shared remote db is *for*: `generated_by` + its index exist so a future
  "who generated what, for how much" report is one `GROUP BY` — splitting turns that
  into a cross-table union or, if split into per-project databases instead (the
  actually-correct way to get real isolation, per Turso's own multi-tenant guidance),
  a scheduled ETL job. Revisit only for a real compliance/isolation requirement or
  measured write contention — not for row count; low millions of rows per project is
  the point where a low-cardinality leading column would start to matter, and this
  isn't near it.
- The local db filename falls back to a hash of the project path when the project id
  hasn't been minted yet. `adopt_path_keyed_db` renames such a file into place once the
  id lands, so a first-open race doesn't strand a whole index.
- **Open `Database` handles are cached** per index file. Building one runs
  `create_dir_all`, opens the file and replays the whole schema, which per call turned
  batch work into an N+1. The cache holds the `Database`, not a `Connection`, so every
  caller still gets its own connection and transactions stay independent.
- **WAL and `busy_timeout` are set once**, at first open. WAL was pointless while the
  handle was discarded every call; `busy_timeout` matters because two aiSLAP windows
  share the file, and real transactions surface `SQLITE_BUSY` where the old per-row
  autocommits mostly got away with it.
- **Prefix queries use a range predicate**, not `LIKE` and not a full scan filtered in
  Rust: `rel_path = p OR (rel_path >= "p/" AND rel_path < "p0")`, since `'/' + 1 == '0'`.
  An index can serve that.
- **Batch writes are batched.** `assets_relink`, `assets_cost_update`, `assets_ingest`
  and `asset_tags_apply` each take a slice and run in one transaction. The per-row
  variants they replaced opened the database once per row.

## The shared price sheet

`db/pricing.rs` — the one table in the remote database that is **not about
assets at all**, and the only part of `db/` with no local counterpart. A price
belongs to an endpoint, not to a project, so `pricing_pull`/`pricing_push`
open the remote straight from `turso_config()` and never touch a project index.

```
pricing(scope, key, value, updated_at, updated_by)   PK (scope, key)
  scope "fal_price"  key <endpoint>                  value "$0.014 per units"
  scope "override"   key <endpoint>[::<resolution>]  value "0.303"
```

- **The shared sheet wins.** `config.json` keeps its `falPrices` /
  `priceOverrides` copy purely as the offline cache: it is what seeds
  `pricesStore` at startup, and all there is when no Turso is configured.
  `lib/sharedPricing.ts` pulls on top of it (fire-and-forget, so startup never
  waits on the network) and merges per key, so a price only one machine has
  fetched isn't lost to someone else's shorter sheet.
- **Last write wins, per row.** A push is an upsert of the rows it was handed —
  never a whole-table replace, which would let a stale copy delete a colleague's
  override. The corollary: **clearing an override is its own delete**
  (`pricing_forget`), because an absence in a pushed map is indistinguishable
  from a key the pusher never had.
- Written on: a price fetch (the whole fetched table), an override edit (that
  one row), a derive-and-apply, and never implicitly. `updated_by` is the OS
  username, same source as `assets.generated_by`.

**`assets.cost_usd_actual`** records whether a row's cost came from fal's billing
ledger or from our own price table. Added by `ensure_column` on both the local and
remote schemas, so existing rows read NULL — correct, since nothing had reconciled
them, and `project_reconcile` restores the real value from the sidecar's
`costUsdActual`, which has carried it all along. It exists because
`db::derive` may only average real invoices; see
[generation-pipeline.md](generation-pipeline.md) § Deriving prices from spend.

## Outbox and Turso sync

Every index write also queues the asset id in `outbox`. There is **no background
timer** — the backend has no notion of an open project (see
[architecture.md](architecture.md) §2), so the frontend triggers `db_sync_outbox`
after asset writes and once per project open.

Sync is purely additive and entirely optional: with `TURSO_DATABASE_URL` /
`TURSO_AUTH_TOKEN` unset, the app is local-only and nothing about it degrades.

## Caching traps

- **`metadataCache.ts` assumes sidecars never change.** Tags broke that premise, hence
  `invalidateImageMetadata`. Anything new that mutates a sidecar must invalidate too.
- **Read-modify-write of `project.json` must use `read_json_strict`.** The lenient read
  returns a default for a damaged file, and the write that follows would commit that
  default — erasing the project id, title, migration flag and the entire tag
  vocabulary. The strict read errors instead, and copies the damaged file aside as
  `project.corrupt-<timestamp>`.
- **`write_json_atomic` renames but does not `fsync`.** A power loss can therefore
  land the rename before the data. Known gap, deliberately unaddressed pending
  measurement on SMB, where the extra round trip is expensive.
- **A partially-written file can be scanned.** The accidental guard is that generation
  writes media *then* sidecar, and reconcile skips sidecar-less files. Anything that
  starts hashing files without sidecars removes that guard.
