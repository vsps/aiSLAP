type Props = {
  title: string;
  onClick: () => void;
};

// Narrow strip a work-surface column collapses to — click to expand again.
// The label reads bottom-to-top (rotated counterclockwise), matching how
// collapsed sidebar tabs are conventionally oriented.
export function CollapsedColumnBar({ title, onClick }: Props) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={`Expand ${title}`}
      className="bg-surface border border-border text-text w-[28px] shrink-0 flex items-center justify-center hover:bg-accent/10 cursor-pointer"
    >
      <span
        className="text-sm font-semibold whitespace-nowrap select-none"
        style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}
      >
        {title}
      </span>
    </button>
  );
}
