import type { ReactNode } from "react";

/** A settings section: an uppercase dim label over its controls. The house
 *  style for a titled block, shared by the settings dialogs and AUDIT.
 *
 *  `yamlKey` names the shared-config YAML key that can supply this field —
 *  see SettingsDialog's "Shared config file" setting. Rendered as a native
 *  mouseover hint on the label rather than a second UI element, so callers
 *  that don't pass it (AUDIT, ProjectSettingsDialog) are unaffected. */
export function Field({
  label,
  yamlKey,
  children,
}: {
  label: string;
  yamlKey?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div
        className="text-xs font-semibold text-dim uppercase tracking-wide"
        title={yamlKey ? `Shared config YAML key: ${yamlKey}` : undefined}
      >
        {label}
      </div>
      {children}
    </div>
  );
}
