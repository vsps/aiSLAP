type Props = {
  title: string;
  onClick: () => void;
  /** Status control pinned to the top of the strip, outside the expand button
   *  (so it stays clickable) — e.g. the prompt's include checkbox. */
  accessory?: React.ReactNode;
};

// Narrow strip a work-surface column collapses to — click to expand again.
// The label reads bottom-to-top (rotated counterclockwise), matching how
// collapsed sidebar tabs are conventionally oriented.
export function CollapsedColumnBar({ title, onClick, accessory }: Props) {
  return (
    <div className="bg-surface border border-border text-text w-[28px] shrink-0 flex flex-col items-center">
      {accessory && <div className="pt-[4px] shrink-0">{accessory}</div>}
      <button
        type="button"
        onClick={onClick}
        title={`Expand ${title}`}
        className="flex-1 min-h-0 w-full flex items-center justify-center hover:bg-accent/10 cursor-pointer"
      >
        <span
          className="text-sm font-semibold whitespace-nowrap select-none"
          style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}
        >
          {title}
        </span>
      </button>
    </div>
  );
}
