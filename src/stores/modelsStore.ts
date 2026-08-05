import { create } from "zustand";
import type { ModelEntry, ModelNode } from "../lib/types";
import { cmd } from "../lib/tauri";
import { pushLog } from "./logStore";

type State = {
  entries: ModelEntry[];
  loaded: boolean;
};

type Actions = {
  loadAll: () => Promise<void>;
  findById: (id: string) => ModelNode | null;
};

export const useModelsStore = create<State & Actions>((set, get) => ({
  entries: [],
  loaded: false,

  async loadAll() {
    try {
      const entries = await cmd.models_load();
      set({ entries, loaded: true });
      // An empty registry looks identical to a broken install in the picker
      // (both show "—"), so say which it is.
      if (entries.length === 0) {
        pushLog("ERROR", "No model definitions found in models/");
      }
    } catch (e) {
      // The log is the surfacing: this store carried an `error` field that no
      // component ever rendered, so a failure here left the picker silently
      // empty. The Rust side reports every path it looked in, which is the
      // useful part.
      set({ loaded: true });
      pushLog("ERROR", `Model definitions failed to load: ${String(e)}`);
    }
  },

  findById(id) {
    return get().entries.find((e) => e.node.id === id)?.node ?? null;
  },
}));
