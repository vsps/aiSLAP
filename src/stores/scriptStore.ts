import { create } from "zustand";
import { cmd } from "../lib/tauri";
import { parseScript, type ParsedScript } from "../lib/script";

type State = {
  raw: string;
  parsed: ParsedScript;
  loadFor: (projectPath: string | null) => Promise<void>;
  save: (projectPath: string, raw: string) => Promise<void>;
};

const empty: ParsedScript = { sequences: [], shotsByParent: new Map() };

export const useScriptStore = create<State>((set) => ({
  raw: "",
  parsed: empty,

  async loadFor(projectPath) {
    if (!projectPath) {
      set({ raw: "", parsed: empty });
      return;
    }
    try {
      const raw = await cmd.script_read(projectPath);
      set({ raw, parsed: parseScript(raw) });
    } catch {
      set({ raw: "", parsed: empty });
    }
  },

  async save(projectPath, raw) {
    await cmd.script_write(projectPath, raw);
    set({ raw, parsed: parseScript(raw) });
  },
}));
