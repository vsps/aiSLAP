import { Btn } from "./Btn";

type Props<T extends string | number> = {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  className?: string;
};

/** A row of mutually exclusive capsules. The 2px gap keeps them reading as
 *  separate controls rather than a segmented bar — which is what the capsule
 *  geometry wants. */
export function ToggleGroup<T extends string | number>({
  value,
  options,
  onChange,
  className = "",
}: Props<T>) {
  return (
    <div className={`inline-flex flex-wrap gap-[2px] ${className}`}>
      {options.map((opt) => (
        <Btn
          key={String(opt.value)}
          variant="toggle"
          active={opt.value === value}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </Btn>
      ))}
    </div>
  );
}
