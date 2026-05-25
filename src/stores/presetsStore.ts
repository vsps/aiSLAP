import { create } from "zustand";
import type { ChainLink, ChainPreset, ChainPresetLink } from "../lib/types";
import { cmd } from "../lib/tauri";
import { makeChainLink, useGenerationStore } from "./generationStore";
import { useModelsStore } from "./modelsStore";

type State = {
  presets: ChainPreset[];
};

type Actions = {
  loadAll: () => Promise<void>;
  save: (name: string, links: ChainPresetLink[]) => Promise<void>;
  delete: (id: string) => Promise<void>;
  applyPreset: (preset: ChainPreset) => void;
};

async function persist(presets: ChainPreset[]): Promise<void> {
  await cmd.presets_save({ presets });
}

export const usePresetsStore = create<State & Actions>((set, get) => ({
  presets: [],

  async loadAll() {
    try {
      const { presets } = await cmd.presets_load();
      set({ presets: Array.isArray(presets) ? presets : [] });
    } catch {
      set({ presets: [] });
    }
  },

  async save(name, links) {
    const preset: ChainPreset = {
      id: crypto.randomUUID(),
      name,
      links,
      createdAt: new Date().toISOString(),
    };
    // Newest first.
    const presets = [preset, ...get().presets];
    set({ presets });
    await persist(presets);
  },

  async delete(id) {
    const presets = get().presets.filter((p) => p.id !== id);
    set({ presets });
    await persist(presets);
  },

  applyPreset(preset) {
    const entries = useModelsStore.getState().entries;
    const links: ChainLink[] = preset.links.map((pl, i) => {
      const model = pl.modelId
        ? (entries.find((e) => e.node.id === pl.modelId)?.node ?? null)
        : null;
      return makeChainLink({
        active: true,
        model,
        settings: pl.settings ?? {},
        sequencePrompt: pl.sequencePrompt ?? "",
        shotPrompts:
          Array.isArray(pl.shotPrompts) && pl.shotPrompts.length > 0
            ? pl.shotPrompts
            : [""],
        refImages: [],
        consumesPrev: i > 0,
      });
    });
    // Expand first link so user can immediately edit / review.
    useGenerationStore.getState().setChain(links, 0);
  },
}));
