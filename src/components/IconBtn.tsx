import type { MouseEventHandler } from "react";
import { Icon } from "../lib/icon";

type Props = {
  name: string;
  size?: number;
  title?: string;
  onClick?: MouseEventHandler<HTMLButtonElement>;
  disabled?: boolean;
  className?: string;
  fill?: boolean;
  /** On/off state. Icon buttons stay square and unfilled — a selected one
   *  shows accent on the glyph rather than taking a capsule fill, so toolbar
   *  strips keep reading as strips. */
  active?: boolean;
};

export function IconBtn({
  name,
  size = 20,
  title,
  onClick,
  disabled,
  className = "",
  fill,
  active,
}: Props) {
  const state =
    disabled ? "opacity-40 cursor-not-allowed"
    : active ? "opacity-100 text-accent cursor-pointer"
    : "opacity-80 hover:opacity-100 hover:text-accent cursor-pointer";

  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={`shrink-0 inline-flex items-center justify-center transition-colors ${state} ${className}`}
    >
      <Icon name={name} size={size} fill={fill ?? active} />
    </button>
  );
}
