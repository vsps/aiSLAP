import { useState } from "react";
import { Btn } from "./Btn";
import { cmd } from "../lib/tauri";
import { confirmAction, showMessage } from "../lib/dialog";
import { useSessionStore } from "../stores/sessionStore";
import { useTagsStore } from "../stores/tagsStore";

/** Rename / recolor / delete the project's tags. Renaming and deleting
 *  rewrite every affected sidecar, so both are confirmed before they run. */
export function TagManager() {
  const projectPath = useSessionStore((s) => s.projectPath);
  const defs = useTagsStore((s) => s.defs);
  const renameTag = useTagsStore((s) => s.renameTag);
  const deleteTag = useTagsStore((s) => s.deleteTag);
  const setColor = useTagsStore((s) => s.setColor);
  const loadDefs = useTagsStore((s) => s.loadDefs);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{
    name: string;
    draft: string;
  } | null>(null);
  const [reindexed, setReindexed] = useState<number | null>(null);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      await showMessage(String(e), { kind: "error" });
    } finally {
      setBusy(false);
    }
  }

  /** Rename and delete rewrite sidecars across the whole project, so the tag
   *  view is stale afterwards whether or not it is the surface on screen.
   *  tagsStore's own `refreshViews` only re-queries it when `viewMode` is
   *  already "tagged" — fine when this lived in a modal over the gallery, not
   *  fine on DELIVER, where the user edits the vocabulary in one pane and
   *  reads the results in another. */
  async function refreshTagged() {
    const session = useSessionStore.getState();
    if (session.projectPath) await session.rescanTagged();
  }

  async function commitRename() {
    if (!editing) return;
    const next = editing.draft.trim();
    const from = editing.name;
    setEditing(null);
    if (!next || next === from) return;
    await run(() => renameTag(from, next));
    await refreshTagged();
  }

  async function removeTag(name: string) {
    const ok = await confirmAction(
      `Remove the "${name}" tag from every image in this project?`,
      { title: "Delete tag", kind: "warning" },
    );
    if (ok) {
      await run(() => deleteTag(name));
      await refreshTagged();
    }
  }

  async function reindex() {
    if (!projectPath) return;
    await run(async () => {
      setReindexed(await cmd.project_tags_reindex(projectPath));
      // Reindex repairs the vocabulary from the sidecars too — pull it back,
      // and refresh the gallery so the dots pick up their colors.
      await loadDefs(projectPath);
      await useSessionStore.getState().rescanShot();
    });
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold text-dim uppercase tracking-wide">
          Tags
        </div>
        <Btn disabled={busy || !projectPath} onClick={reindex}>
          {busy ? "Working…" : "Rebuild tag index"}
        </Btn>
      </div>
      <div className="text-xs text-dim">
        Tags live in each image's <code>.json</code> sidecar, so they follow the
        file when it's copied, moved, or renamed. Rebuilding re-reads those
        sidecars into the local index and re-derives the tag list below from
        them — cheaper than a full reconcile, and the fix if tags ever look out
        of date or the list here looks empty.
      </div>
      {reindexed !== null && (
        <div className="text-xs font-mono text-text">
          Reindexed {reindexed} tagged file(s)
        </div>
      )}
      {defs.length === 0 ? (
        <div className="text-xs text-dim">
          No tags yet — add one from any thumbnail.
        </div>
      ) : (
        <div className="flex flex-col gap-0.5">
          {defs.map((d) => (
            <div key={d.name} className="flex items-center gap-2 text-xs">
              <input
                type="color"
                value={d.color || "#9b31f2"}
                disabled={busy}
                onChange={(e) =>
                  void run(() => setColor(d.name, e.target.value))
                }
                title={`Color for "${d.name}"`}
                className="w-5 h-5 bg-inset border border-dim p-0 cursor-pointer"
              />
              {editing?.name === d.name ? (
                <input
                  autoFocus
                  value={editing.draft}
                  disabled={busy}
                  onChange={(e) =>
                    setEditing({ name: d.name, draft: e.target.value })
                  }
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void commitRename();
                    if (e.key === "Escape") setEditing(null);
                  }}
                  className="flex-1 min-w-0 bg-inset px-1 py-[1px] outline-none"
                />
              ) : (
                <Btn
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setEditing({ name: d.name, draft: d.name })}
                  title="Rename (rewrites every sidecar using this tag)"
                  className="flex-1 min-w-0 justify-start px-1 py-[1px] truncate"
                >
                  {d.name}
                </Btn>
              )}
              <Btn disabled={busy} onClick={() => void removeTag(d.name)}>
                DELETE
              </Btn>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
