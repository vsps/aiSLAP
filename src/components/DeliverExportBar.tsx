import { useState } from "react";
import { cmd } from "../lib/tauri";
import { pickDirectory, showMessage } from "../lib/dialog";
import { useExportPaths, useVisiblePaths } from "../lib/galleryFilter";
import { useSessionStore } from "../stores/sessionStore";

type Layout = "preserve" | "dump";

/**
 * Exports what the gallery is listing.
 *
 * There is deliberately no tag picker here. The set is whatever the filter bar
 * has narrowed the gallery to, minus anything the user un-ticked — so the
 * thing being exported is the thing on screen, and there is no second place to
 * state a filter that can drift out of step with the first.
 */
export function DeliverExportBar() {
  const projectPath = useSessionStore((s) => s.projectPath);
  const viewMode = useSessionStore((s) => s.viewMode);
  const traceActive = useSessionStore((s) => s.traceActive);
  const setDeliverExcluded = useSessionStore((s) => s.setDeliverExcluded);

  const visible = useVisiblePaths();
  const selected = useExportPaths();

  const [layout, setLayout] = useState<Layout>("preserve");
  const [busy, setBusy] = useState(false);

  // Stacked view draws one tile per version *stack* rather than per image, and
  // applies no tag filter at all; trace view is an ancestry graph. Neither has
  // a "listed set" to export, so say so rather than exporting something the
  // user is not looking at.
  const unsupported = traceActive
    ? "trace"
    : viewMode === "stacked"
      ? "stacked"
      : null;

  async function runExport() {
    if (!projectPath || selected.length === 0) return;
    const dir = await pickDirectory("Select destination for the export");
    if (!dir) return;
    setBusy(true);
    try {
      const count = await cmd.export_paths(projectPath, selected, dir, layout);
      await showMessage(`Exported ${count} file(s) to ${dir}`, { kind: "info" });
    } catch (e) {
      await showMessage(String(e), { kind: "error" });
    } finally {
      setBusy(false);
    }
  }

  if (unsupported) {
    return (
      <div className="shrink-0 flex items-center gap-2 px-2 py-1 bg-surface border border-border text-xs text-dim">
        Export needs a listed set — switch to the columns or tagged view.
      </div>
    );
  }

  return (
    <div className="shrink-0 flex items-center gap-3 px-2 py-1 bg-surface border border-border text-xs">
      <span className="font-semibold text-text whitespace-nowrap">
        {selected.length} of {visible.length}
      </span>

      <button
        type="button"
        className="px-2 py-[2px] bg-bg hover:bg-panel disabled:opacity-40"
        disabled={visible.length === 0 || selected.length === visible.length}
        onClick={() => setDeliverExcluded([])}
      >
        All
      </button>
      <button
        type="button"
        className="px-2 py-[2px] bg-bg hover:bg-panel disabled:opacity-40"
        disabled={selected.length === 0}
        onClick={() => setDeliverExcluded(visible)}
      >
        None
      </button>

      <span className="w-px self-stretch bg-border" />

      <label className="flex items-center gap-1 cursor-pointer whitespace-nowrap">
        <input
          type="radio"
          checked={layout === "preserve"}
          onChange={() => setLayout("preserve")}
        />
        <span>Preserve folders</span>
      </label>
      <label className="flex items-center gap-1 cursor-pointer whitespace-nowrap">
        <input
          type="radio"
          checked={layout === "dump"}
          onChange={() => setLayout("dump")}
        />
        <span>One folder</span>
        <span className="text-dim">(seq_shot_ prefix)</span>
      </label>

      <span className="flex-1" />

      <button
        type="button"
        className="px-3 py-[2px] bg-accent text-text disabled:opacity-50"
        disabled={busy || !projectPath || selected.length === 0}
        onClick={runExport}
      >
        EXPORT
      </button>
    </div>
  );
}
