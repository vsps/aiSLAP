import { create } from "zustand";
import type { ModelEntry, ModelNode } from "../lib/types";
import { cmd } from "../lib/tauri";
import { pushLog } from "./logStore";

type State = {
  entries: ModelEntry[];
  loaded: boolean;
  error: string | null;
};

type Actions = {
  loadAll: () => Promise<void>;
  findById: (id: string) => ModelNode | null;
  imageEntries: () => ModelEntry[];
  videoEntries: () => ModelEntry[];
  model3dEntries: () => ModelEntry[];
};

export const useModelsStore = create<State & Actions>((set, get) => ({
  entries: [],
  loaded: false,
  error: null,

  async loadAll() {
    try {
      const entries = await cmd.models_load();
      set({ entries, loaded: true, error: null });
      // An empty registry looks identical to a broken install in the picker
      // (both show "—"), so say which it is.
      if (entries.length === 0) {
        pushLog("ERROR", "No model definitions found in models/");
      }
    } catch (e) {
      // `error` on this store was never rendered anywhere, so a failure here
      // used to leave the model picker silently empty — the Rust side reports
      // every path it looked in, which is the useful part.
      const message = String(e);
      set({ error: message, loaded: true });
      pushLog("ERROR", `Model definitions failed to load: ${message}`);
    }
  },

  findById(id) {
    return get().entries.find((e) => e.node.id === id)?.node ?? null;
  },

  imageEntries() {
    return get().entries.filter((e) => e.node.kind === "image");
  },
  videoEntries() {
    return get().entries.filter((e) => e.node.kind === "video");
  },
  model3dEntries() {
    return get().entries.filter((e) => e.node.kind === "model3d");
  },
}));
