import { create } from "zustand";
import type { ModelEntry, ModelNode } from "../lib/types";
import { cmd } from "../lib/tauri";

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
    } catch (e) {
      set({ error: String(e), loaded: true });
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
