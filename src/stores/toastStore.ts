import { create } from "zustand";

/**
 * Transient, non-blocking confirmations.
 *
 * `showMessage` in `lib/dialog.ts` is a *native* OS dialog — it steals focus
 * and the user has to dismiss it before doing anything else. That is right for
 * "this failed" and for "this is about to overwrite your work", and wrong for
 * "that worked": confirming a success by making someone click OK charges them
 * for the good outcome.
 *
 * App-global rather than per-tab, like `logStore`: a toast belongs to the
 * moment, not to a project, and the tab could be switched out from under it.
 */
export type Toast = { id: number; text: string };

/** How long a toast stays up before it starts fading. The fade itself is CSS
 *  in `Toaster.tsx`, and its duration is added on top of this. */
export const TOAST_DWELL_MS = 2000;

type State = { toasts: Toast[] };

type Actions = {
  push: (text: string) => void;
  dismiss: (id: number) => void;
};

let counter = 0;

export const useToastStore = create<State & Actions>((set) => ({
  toasts: [],
  push(text) {
    const toast: Toast = { id: ++counter, text };
    set((s) => ({ toasts: [...s.toasts, toast] }));
  },
  dismiss(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
}));

/** Say that something worked, without interrupting anyone.
 *
 *  Deliberately has no `kind`. A toast that can be an error is a toast that
 *  gets used for errors, and an error nobody has to acknowledge is an error
 *  nobody reads — those stay on `showMessage`. */
export function showToast(text: string): void {
  useToastStore.getState().push(text);
}
