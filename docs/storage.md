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
  SRC/                   project-wide inputs
  <sequence>/
    sequence.json
    <shot>/
      shot.json          prompt history, version selects, clip media
      SRC/               shot inputs
      SEL/               legacy — see below
      v001/ gen001/ …    one folder per generation batch
```

**PRISM:** the same, except the shot level is `<entity>/Renders/AI`. See
[prism.md](prism.md).

> **`SEL/` is deliberate legacy.** It still renders as a gallery column where it
> exists, but nothing is ever moved into one — its role was replaced by the `select`
> tag. Every directory scan treats `SRC`, `SEL` and `.`/`$`-prefixed names as
> non-version folders.

## The media triple

```
clip.mp4            the media
clip.json           its sidecar — the durable record
clip.thumb.png      poster frame, for video and 3D
```

These move as a unit through copy, move, rename **and export**. `fsutil.rs` provides
`sidecar_path`, `thumb_path` and `is_thumb` so no caller has to rebuild those names by
hand — the export path silently dropped thumbnails for exactly that reason before the
helpers existed.

The sidecar carries the prompt pieces, the exact `combinedPrompt` sent, the settings,
a ref snapshot, the provider response, `costUsd`, the chain lineage, `tags`, `assetId`
and `contentHash`.

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
`asset_refs`, `asset_tags`, `outbox` (plus `shot_state` and `prompt_history`, created
ahead of the feature that will use them).

It is a **cache**. Deleting it costs a reindex, not data.

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
