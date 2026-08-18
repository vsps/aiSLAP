# The timeline

A single-track assembly strip for reviewing a sequence's shots in order and
handing the result off. Deliberately a **rough-cut tool, not a finishing NLE** —
see §7 for what that rules out.

Layer placement and store ownership: [architecture.md](architecture.md).

## 1. The clip model

`SequenceTimeline` (`lib/types.ts`, mirrored by `domain.rs`) is
`{ totalDurationSec, clips[] }`, persisted as `timeline.json` in the **sequence**
directory (`TIMELINE_SIDECAR` in `commands/fsutil.rs`), atomic-written and
debounced from `timelineStore`.

A `TimelineClip` carries `{ id, shotPath, enabled, durationSec, mediaPath,
sourceOffsetSec }`. Two consequences worth internalising:

- **Order is array order. There is no start-time field.** A clip's position on
  the timeline is the running sum of the `durationSec` of everything before it.
  Every consumer recomputes that sum; none of them cache it.
- **There is no separate project file.** The edit list *is* the sequence
  sidecar, which is why creating a shot has to reconcile into it (§3).

## 2. Media resolution

`resolveClipMedia()` in `timelineStore.ts` — a three-level fallback, first hit wins:

1. `clip.mediaPath` — the per-clip override set from `ClipMediaPicker`.
2. the shot sidecar's `clipMediaPath` — the per-shot exclusive pick.
3. the shot's latest version's last file.

Returns `null` for blank clips and for shots with nothing resolvable; callers
render those as blanks rather than erroring.

**Durations are probed in the browser, not by ffmpeg.** `Timeline` mounts
detached `<video preload="metadata">` elements for any unprobed path and records
`loadedmetadata` into `videoDurations` (path → seconds). `video_info_probe` is
*not* on this path — it serves `TrimMode` and `ComparePreview` only. A clip still
sitting at the 5s default is auto-resized once its real duration lands.

## 3. Invariants

- **The auto-pad is never persisted.** `getDisplayClips()` appends an in-memory
  blank when the user clips underflow `totalDurationSec`. Anything iterating
  display clips must treat index `>= clips.length` as the pad and refuse to
  reorder, slip, disable or export it.
- **Reconciliation is load-time and idempotent.** `loadForSequence` drops clips
  whose shot is gone, appends a default clip for any unreferenced shot, grows
  `totalDurationSec` if the clip sum exceeds it, and re-saves only if something
  changed.
- **`setBoundary` is a rubber band, not a resize.** It moves time between two
  adjacent clips; the total is fixed. Its argument is a *delta from current*, so
  a drag handler must track what it has already applied — see the
  `lastAppliedSec` accumulator in `Timeline`.
- **Slip direction follows the NLE convention.** Dragging right moves visible
  content right, which means *earlier* source under the slot, which means
  `sourceOffsetSec` **decreases**. Inverting this is the obvious-looking bug.
- **`setTotalDuration` rescales every clip proportionally.** It is not a trim.

## 4. Playback

Time is driven by a `requestAnimationFrame` **wall-clock** loop in `Timeline`
that advances `playheadSec`; the video element is slaved to it, not the reverse.

`TimelinePreview` in `LatestImageColumn.tsx` is a persistent **two-slot** `<video>`
pool: one slot plays the active clip while the other preloads and pre-seeks the
next video clip (`nextVideoClipAfter()`), so a boundary crossing doesn't hitch.
Stills and blanks render as overlays above the pool so the upcoming video stays
warm. A slot resyncs `currentTime` when it drifts more than 0.15s from the
playhead.

Consequence, **deliberate**: playback is smooth but not frame-locked. Frame
accuracy lives in `TrimMode`, which has its own probed-fps scrubber.

## 5. Rendering to video

`ExportModal` → `buildSegments()` (in `timelineStore.ts`) → `cmd.timeline_export`
→ `commands/media.rs`.

`buildSegments()` is the single flattening step every exporter shares. It
collapses disabled clips, the pad, and unresolvable media to `blank`, so the
result is **positionally complete** — segment N starts where N−1 ended. It also
clamps `sourceOffsetSec` against the probed duration.

The Rust side builds one `-filter_complex`: a per-input normalise chain
(`scale` + `pad` letterbox, `setsar=1`, `fps`, `trim`, `setpts`) into a single
`concat`. mp4 / libx264 / yuv420p only.

**Deliberate:** ffmpeg is an external binary the user points at in Settings —
nothing is bundled, and probe/thumbnail commands soft-fail to `None`/`false`
when it is missing rather than erroring.

**Known gap:** the concat filter is `a=0`. The rendered output has **no audio**,
and nothing in the app plays or edits audio files.

**Known gap:** export is one blocking call — no progress, no cancel.

## 6. Interchange export

`commands/interchange.rs` writes the edit list as an edit *decision* instead of a
movie, so a rough cut conforms in a real NLE against the original files. Same
`buildSegments()` input; no ffmpeg involved, so it works with no ffmpeg configured.

| Format | Extension | Notes |
|---|---|---|
| OTIO | `.otio` | `Timeline.1` / `Track.1` / `Clip.1` / `Gap.1`. Native import in Resolve 17+ (free and Studio) and Premiere. Preferred. |
| FCP7 XML | `.xml` | `xmeml` v5. Wider reach. **Not** modern Final Cut's `.fcpxml` — hence the `xmeml` format key. |

Contracts that the unit tests in that module pin down:

- **Frames are quantised from the cumulative second**, never by summing
  per-clip frame counts, so rounding cannot accumulate. Items stay butt-joined
  and no item is ever zero-length.
- **In xmeml, `start`/`end` are timeline frames and `in`/`out` are source
  frames.** A slipped clip has `in = round(sourceOffsetSec * fps)`.
- **In xmeml a gap is the absence of a `clipitem`** — the numbering skips. There
  is no blank element. In OTIO it is a real `Gap.1`.
- **A `<file>` is declared once and referenced by id after that.** The same take
  legitimately appears in two clips.
- `sourceDurationSec` rides along on the `video` segment so OTIO can write
  `available_range` and xmeml a truthful `<file><duration>` — that is what keeps
  the trim adjustable after import instead of baked in. A file is never declared
  shorter than the slice taken from it. Stills get a nominal one-hour duration.
- Paths become absolute `file:` URLs, percent-encoded, `/` and `:` preserved so a
  drive letter survives. OTIO uses `file:///C:/…`, xmeml `file://localhost/C:/…`,
  and a UNC path keeps its own server as the authority.

**Deliberate:** no EDL. CMX3600 conforms by source timecode, which generated
clips don't have, and its 8-character reel names can't carry a filename.

## 7. Deliberate limits and known gaps

**Deliberate** — the timeline is scoped to rough assembly. Finishing happens
downstream via §6.

**Known gaps**, roughly in order of how much they hurt:

- No audio anywhere — no track, no waveform, no audio in the render.
- No timeline zoom or horizontal scroll; the strip always fits 100% width.
- No undo/redo, multi-select, or copy/paste of clips.
- No keyboard transport on the strip — no spacebar, no J/K/L. (`TrimMode` has
  its own keys.)
- No razor/split, ripple/roll, snapping, markers, or timecode ruler.
- No transitions, effects, titles, or retime.
- Single track, hard-coded.

Several of these are blocked less by UI work than by `SequenceTimeline` being
too thin to express them — it has no tracks, no start times, and no audio.
