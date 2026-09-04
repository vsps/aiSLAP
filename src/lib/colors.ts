import type { ColorOverrides } from "./types";

export const DEFAULT_COLORS: Required<ColorOverrides> = {
  bg: "#303030",
  border: "#202020",
  src: "#353535",
  handle: "#505050",
  text: "#aaaaaa",
  accent: "#9b31f2",
};

export const COLOR_KEYS: (keyof ColorOverrides)[] = [
  "bg",
  "src",
  "text",
  "accent",
  "handle",
  "border",
];

/** Parse `#rgb` / `#rrggbb` into 0-255 channels. Null for anything else —
 *  notably `UNKNOWN_TAG_COLOR`, which is the literal string "var(--color-dim)"
 *  and reaches these helpers through `tagColor()`. */
function parseHex(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const h = m[1];
  const full =
    h.length === 3 ? h[0] + h[0] + h[1] + h[1] + h[2] + h[2] : h;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

function hexToHsl(hex: string): [number, number, number] | null {
  const rgb = parseHex(hex);
  if (!rgb) return null;
  const [r, g, b] = rgb.map((c) => c / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return [h, s, l];
}

function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const seg = Math.floor(h / 60) % 6;
  const [r, g, b] = (
    [
      [c, x, 0],
      [x, c, 0],
      [0, c, x],
      [0, x, c],
      [x, 0, c],
      [c, 0, x],
    ] as const
  )[seg];
  const to255 = (v: number) =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${to255(r)}${to255(g)}${to255(b)}`;
}

/** The accent at half saturation — the fill every button carries. Hue and
 *  lightness are preserved, so it reads as the same colour, just calmer.
 *  Returns the input unchanged when it isn't a hex we can parse. */
export function mutedAccent(hex: string): string {
  const hsl = hexToHsl(hex);
  if (!hsl) return hex;
  return hslToHex(hsl[0], hsl[1] * 0.5, hsl[2]);
}

/** Black or white, whichever contrasts better with `hex`.
 *
 *  0.1791 is where the two contrast ratios cross: solving
 *  (1.05)/(L+0.05) = (L+0.05)/0.05 gives L = sqrt(0.0525) - 0.05. Below it
 *  white wins, above it black. Null when `hex` isn't parseable, so callers can
 *  fall back to inheriting the surrounding text colour.
 *
 *  Note the accent and its muted variant can land on opposite sides of this
 *  line — the default #9b31f2 (L 0.156) takes white while its half-saturation
 *  form #9661c2 (L 0.189) takes black — which is why they get separate tokens
 *  rather than sharing one. */
export function readableOn(hex: string): string | null {
  const rgb = parseHex(hex);
  if (!rgb) return null;
  const [r, g, b] = rgb.map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum > 0.1791 ? "#000000" : "#ffffff";
}

/** Push overrides into :root CSS custom properties. Always sets explicit values — never
 *  removes properties — so Tailwind utilities always resolve to the expected color. */
export function applyColors(overrides: ColorOverrides | null | undefined): void {
  const root = document.documentElement;
  for (const key of COLOR_KEYS) {
    const value = (overrides?.[key]) ?? DEFAULT_COLORS[key];
    const cssVar =
      key === "src" ? "--color-src-bg"
      : key === "border" ? "--color-border"
      : key === "handle" ? "--color-handle"
      : `--color-${key}`;
    root.style.setProperty(cssVar, value);
    if (key === "bg") {
      root.style.setProperty("--color-panel", value);
      root.style.setProperty("--color-surface", value);
      root.style.setProperty("--color-gallery-surface", value);
    }
    if (key === "src") {
      root.style.setProperty("--color-inset", value);
    }
    if (key === "accent") {
      // Buttons carry the accent at half saturation; selected controls carry it
      // at full strength. Each needs its own readable foreground — halving
      // saturation shifts luminance, so the two can want opposite text colours
      // (see readableOn). A pale accent gets dark text, a deep one light.
      const muted = mutedAccent(value);
      root.style.setProperty("--color-accent-muted", muted);
      root.style.setProperty("--color-on-accent", readableOn(value) ?? "#ffffff");
      root.style.setProperty(
        "--color-on-accent-muted",
        readableOn(muted) ?? "#ffffff",
      );
    }
  }
}
