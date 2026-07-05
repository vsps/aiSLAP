import { create } from "zustand";
import type { LogEvent } from "../lib/types";

// Raised from 50 now that console.error/warn and uncaught errors also flow
// in here (see lib/consoleCapture.ts) — noisy third-party warnings shouldn't
// push real job errors out of the buffer.
const MAX = 300;

type LogLine = LogEvent & { id: number; timestamp: string };

type State = {
  lines: LogLine[];
};

type Actions = {
  push: (level: LogEvent["level"], message: string, tag?: string) => void;
  clear: () => void;
};

let counter = 0;

export const useLogStore = create<State & Actions>((set) => ({
  lines: [],
  push(level, message, tag) {
    const line: LogLine = {
      id: ++counter,
      level,
      message,
      tag,
      timestamp: new Date().toISOString(),
    };
    set((s) => {
      const next = [...s.lines, line];
      if (next.length > MAX) next.splice(0, next.length - MAX);
      return { lines: next };
    });
  },
  clear() {
    set({ lines: [] });
  },
}));

export function pushLog(level: LogEvent["level"], message: string, tag?: string): void {
  useLogStore.getState().push(level, message, tag);
}
