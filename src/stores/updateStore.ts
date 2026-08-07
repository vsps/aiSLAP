import { create } from "zustand";
import type { Update } from "../lib/updater";

type State = {
  /** Set by the background auto-check on launch, or the manual "Check for
   *  updates" button in Settings — either path renders the same dialog. */
  pendingUpdate: Update | null;
};

type Actions = {
  setPendingUpdate: (update: Update | null) => void;
};

export const useUpdateStore = create<State & Actions>((set) => ({
  pendingUpdate: null,
  setPendingUpdate: (update) => set({ pendingUpdate: update }),
}));
