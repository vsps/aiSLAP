import type { ReactNode } from "react";

/** A settings section: an uppercase dim label over its controls. The house
 *  style for a titled block, shared by the settings dialogs and AUDIT. */
export function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="text-xs font-semibold text-dim uppercase tracking-wide">
        {label}
      </div>
      {children}
    </div>
  );
}
