import type { ButtonHTMLAttributes } from "react";

/** `solid`  — a plain action. Accent at half saturation.
 *  `toggle` — a control with an on/off state. Reads as `solid` when off and
 *             brightens to the full accent when `active`.
 *  `ghost`  — text only, no fill: disclosures, tab strips, inline links. The
 *             exception, for controls a capsule would be wrong on. */
type Variant = "solid" | "toggle" | "ghost";

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  /** `sm` for the app's dense rows (the default), `md` for modal footers. */
  size?: "sm" | "md";
  /** `toggle` only — whether this control is currently on. */
  active?: boolean;
};

const SIZE = {
  sm: "px-2.5 py-[2px] text-xs",
  md: "px-3.5 py-1 text-xs",
} as const;

const FILL =
  "bg-accent-muted text-on-accent-muted hover:bg-accent hover:text-on-accent";

/**
 * Every labelled button in the app. Capsule geometry, accent-derived fill,
 * one disabled treatment — so a button looks the same wherever it lands.
 *
 * Icon-only controls are deliberately NOT this: they stay square and unfilled
 * (see `IconBtn`), because a row of gallery-toolbar glyphs reads as a strip,
 * not as a run of pills.
 */
export function Btn({
  variant = "solid",
  size = "sm",
  active = false,
  className = "",
  type = "button",
  ...rest
}: Props) {
  const look =
    variant === "ghost"
      ? "text-text hover:text-accent"
      : variant === "toggle" && active
        ? "bg-accent text-on-accent"
        : FILL;

  // `ghost` carries no fill, so the capsule padding would only push its
  // neighbours around — it keeps its own spacing via className.
  const box = variant === "ghost" ? "" : `rounded-full ${SIZE[size]}`;

  return (
    <button
      type={type}
      aria-pressed={variant === "toggle" ? active : undefined}
      className={`inline-flex items-center justify-center gap-1 whitespace-nowrap cursor-pointer transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${box} ${look} ${className}`}
      {...rest}
    />
  );
}
