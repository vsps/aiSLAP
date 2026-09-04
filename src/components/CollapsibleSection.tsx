import { useState, type ReactNode } from "react";
import { Btn } from "./Btn";

type Props = {
  label: string;
  /** Open on first render. Collapsed state is component-local: it dies with
   *  the mount, which is what you want for a section a user opens to make one
   *  edit and forgets about. */
  defaultOpen?: boolean;
  children: ReactNode;
};

/**
 * A titled block that folds away. The app's other collapse affordances are all
 * the same shape — a 28px vertical strip a *column* collapses to — which is the
 * wrong axis for a stacked section, so this is its own thing rather than a
 * reuse of `CollapsedColumnBar`.
 */
export function CollapsibleSection({ label, defaultOpen, children }: Props) {
  const [open, setOpen] = useState(!!defaultOpen);
  return (
    <div className="flex flex-col gap-1">
      <Btn
        variant="ghost"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="text-xs font-bold uppercase tracking-wide self-start"
      >
        <span className="material-symbols-outlined" style={{ fontSize: 16 }}>
          {open ? "expand_more" : "chevron_right"}
        </span>
        {label}
      </Btn>
      {open && children}
    </div>
  );
}
