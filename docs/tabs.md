# Tabs

Each tab is a whole session: its own project, sequence and shot, its own gallery,
its own prompt chain, its own job list. Two tabs can sit in two different
projects at once.

Read [architecture.md](architecture.md) first — this file assumes §2's three
rules and adds the one that tabs introduce.

---

## 1. The rule tabs add

**Async work binds to the tab that started it, at the moment it starts.**

Everything else here follows from that. A generation outlives the tab switch
that usually follows pressing Run, so a job that reaches back for "the current
shot" gets whichever tab happens to be in front — a different shot, a different
project, someone else's queue.

The mechanism is `JobSpec.tabId`, stamped in `enqueue.ts` and resolved in
`runner.ts` via `storesFor()`. The same discipline applies to boot restore
(`bootstrap.ts` holds each `Tab` it is restoring), orphan recovery, and the
handful of `actions.ts` helpers that write after an `await`.

---

## 2. Which stores are per-tab

| Per-tab | App-global |
|---|---|
| `sessionStore` — paths, gallery columns, selection, trace, view mode | `modelsStore`, `pricesStore`, `presetsStore` |
| `generationStore` — chain links, jobs, pending outputs | `logStore`, `updateStore`, `costReportStore` |
| `timelineStore` — clips, playhead (per sequence) | `layoutStore` — one window, one layout |
| `scriptStore` — parsed `script.md` (per project) | `tabsStore` — the tab list itself |
| `tagsStore` — vocabulary + filter (per project) | |

A per-tab store is a factory (`createSessionStore`, …) rather than a
`create()` singleton, and `tabStores.ts::createTabStores` builds the five as one
mutually-aware bundle. Module-level mutable state inside those files moved into
the factory closure for the same reason — a shared `saveTimer` in
`timelineStore` would have let one tab's edit cancel another tab's queued write
to a different `timeline.json`.

---

## 3. How 400 call sites survived

`tabScoped.ts` exports a **proxy** per slot: a full zustand store API plus the
callable hook form, forwarding to the active tab's real instance.
`useSessionStore((s) => s.shotPath)`, `useSessionStore.getState()` and
`useSessionStore.setState(...)` all work unchanged, because almost every call
site means "the tab the user is looking at" — which is exactly what the proxy
serves.

`tabsStore` is the only caller of `setActiveTabStores`. That re-points every
proxy and then fires each proxy's listeners once, so `useSyncExternalStore`
re-reads and the whole tree renders against the new tab. No component knows tabs
exist.

Non-React subscribers are handed `(state, state)`, so a change-gated
subscription sees no diff and a tab switch doesn't look like an edit.

### Two consequences, both load-bearing

1. **Only the active tab's React tree may be mounted.** `App.tsx` keys the
   session-scoped panels on the active tab id. A hidden tab's components would
   read through the proxy and render the *front* tab's data. This also bounds
   memory: one gallery's thumbnails, not N.
2. **Anything that outlives a switch must hold its own bundle** — §1.

Deliberate side effect of the keying: switching tabs resets component-local
state and DOM. Scroll offsets, a half-typed inline rename, timeline playback.
Everything that matters is already in the tab's stores (selection, zoom, compare
slots, target version), so what is lost is only what was never worth keeping.

### Reaching a specific tab

| Need | Use |
|---|---|
| the front tab, imperatively | `activeStores()` |
| a tab you captured earlier | `storesFor(tabId)` — null once it's closed |
| every tab (fan-out) | `allTabs()` |
| stamp work for later | `activeTabId()` |

---

## 4. The queue spans tabs

One concurrency cap and one provider budget, however many tabs are open — two
tabs submitting does not double what is in flight. `pumpQueue` walks every tab's
`jobs` and dispatches FIFO by `Job.startedAt` (a `performance.now()` reading, so
it is comparable between tabs).

Jobs are *attributed*, not partitioned: `QueueChecklist` shows the active tab's
queue, and `LogWindow` labels lines with the owning tab's position (`#2`) when
more than one tab is open.

### What a tab chip's colour means

| Colour | Meaning |
|---|---|
| orange (`text-warn`), `● N` | this tab has N jobs queued or running |
| green + bold (`text-ok`), `▲ N` | N results landed here that the user hasn't come back to |
| dim / plain | idle, nothing waiting |

Busy wins when both are true — "still working" is the live fact, and the green
call-to-action arrives on its own the moment the queue drains.

"Unseen" is `generationStore.unseenOutputs`, and it only counts results that
landed while the tab was **not** in front (`runner.ts` checks `activeTabId()`
per iteration, so a long run lights the tab on its first file rather than its
last). Orphan recovery counts too: a file that arrived while the app wasn't even
running is as unseen as it gets. Switching to a tab is what clears it —
`setActive` calls `markOutputsSeen`. It is never persisted; being told about a
result you saw two launches ago is noise, not news.

**Closing a tab does not cancel its jobs.** The media file and its sidecar are
the durable commit (rule 1), so the work runs to completion and lands on disk;
`genFor()` returns null and the status updates are skipped. Closing a tab with
jobs in flight, or with prompt text that has never been generated with, asks for
confirmation first — see `lib/tabs.ts::requestCloseTab`.

`cancelAllGenerations` is scoped to the **active tab**: it is the RunColumn's
button, and the user means the work in front of them.

---

## 5. Filesystem changes fan out

With one session, "is this the open shot?" had one answer. Now it has zero, one
or several, and every such check became a fan-out:

- A finished iteration rescans **every** tab showing that shot
  (`runner.ts::rescanViewersOf`).
- Orphan recovery rescans every tab holding a shot it wrote into.
- A rename re-points every tab inside the renamed subtree
  (`actions.ts::repointTabsAfterRename`), rewrites timeline and chain-ref paths
  in all tabs, and reloads `script.md` in the other tabs holding that project.
- The rename job guard spans tabs (`inFlightJobsAnywhere`). A background tab
  generating into the folder being renamed is exactly as fatal as the front one
  doing it, and it used to be invisible.

---

## 6. Persistence

`app-state.json` grew a `tabs` array (`TabPersisted[]`) plus `activeTabIdx`.
Tabs are identified by **position** — ids are minted per launch and mean nothing
across runs.

The pre-`tabs` fields are still written, mirroring the active tab, so an older
build (or a downgrade) reopens something sensible. A file without `tabs` loads
as a single tab via `legacyTab()`.

Restore order is the front tab first, then the rest one at a time. Each restore
is a burst of directory walks, and firing N at a network drive at once makes the
tab the user is actually waiting on the slowest to arrive.

The persistence subscription is **per tab and direct**, never through a proxy: a
background tab finishing its restore still has to be written. Keep the gate in
`installPersistence` in step with `tabToPersisted` — a missing field shows up as
silent non-persistence, never as a wrong write.

### `app-state.json` is untyped in Rust, on purpose

There is no `AppState` struct in `domain.rs`. A typed mirror was worse than
none: serde dropped every field the struct hadn't been taught about, so
`chainLinks` and `chainExpandedIdx` were silently discarded on every save and
the prompt chain never actually survived a restart. Per rule 3 this is frontend
state; `app_state_load`/`app_state_save` pass the JSON through, the way
`presets_load` already did.

---

## 7. New tab semantics

| Action | Result |
|---|---|
| `+` / Ctrl+T | Same project and sequence, **no shot**, fresh single-link chain |
| duplicate | Same project/sequence/shot **and** a copy of the chain |
| Ctrl+W | Close (guarded), never the last tab |
| Ctrl+Tab / Ctrl+Shift+Tab | Cycle |
| Ctrl+1…9 | Jump to position |

A new tab deliberately opens no shot: the point is to work on a *different* one,
and auto-opening the shot the other tab holds invites two tabs writing into one
version dir before the user has asked for that. `setSequence` takes
`{ openLastShot: false }` for this.

---

## 8. Deliberate limits, and known gaps

| Thing | Status | Why |
|---|---|---|
| One tab mounted at a time | **deliberate** | Forced by the proxy design (§3), and it bounds memory. Background playback and scroll position are the price. |
| Tab state is memory-only until the next app-state write | **deliberate** | Same debounce as before tabs. `requestCloseTab` guards the loss that matters. |
| N tabs on one project run N redundant `project_reconcile` / tag-migrate passes at boot | **known gap** | All fire-and-forget and idempotent, so it costs time on a slow drive, not correctness. |
| Same shot open in two tabs | **allowed** | `version_create_next` now claims a folder with `create_dir` and walks forward on collision, so both tabs can generate. Nothing else coordinates them. |
| Log lines from user actions carry no tab label | **deliberate** | They're emitted from the tab already on screen. Only the runner, which outlives switches, stamps `tabId`. |
