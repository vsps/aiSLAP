import { create } from "zustand";
import { cmd } from "../lib/tauri";
import type { AssetTrace } from "../lib/types";

// The AUDIT file lookup. In a store rather than component state for the same
// reason as costReportStore: the result is expensive to reproduce (hashing the
// file, then a query against every index on the machine) and the panel
// unmounts whenever the user leaves AUDIT. It also gives the app-level OS
// drag-drop listener something to call — a file dropped on the lookup zone
// runs through here, not through the component.
//
// In-memory only: a lookup is a question about a file the user has in front of
// them right now, not something to restore on next launch.
type State = {
  trace: AssetTrace | null;
  busy: boolean;
  /** Non-null only for a failed lookup; a lookup that found nothing is a
   *  result (`trace.matches` empty), not an error. */
  error: string | null;
};

type Actions = {
  run: (path: string) => Promise<void>;
  clear: () => void;
};

export const useAssetTraceStore = create<State & Actions>((set) => ({
  trace: null,
  busy: false,
  error: null,
  async run(path) {
    set({ busy: true, error: null });
    try {
      // ffmpeg is how an id embedded in a video is read back; without it the
      // lookup still works, it just falls through to the content hash.
      const config = await cmd.config_load().catch(() => null);
      set({ trace: await cmd.asset_trace(path, config?.ffmpegPath ?? "") });
    } catch (e) {
      set({ trace: null, error: String(e) });
    } finally {
      set({ busy: false });
    }
  },
  clear() {
    set({ trace: null, error: null });
  },
}));
