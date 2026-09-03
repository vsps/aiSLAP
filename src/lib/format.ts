// Small display-formatting helpers shared across components.

/** "HH:MM:SS" from an ISO timestamp, in local time. */
export function formatTime(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** "12.4 MB" from a byte count. Decimal units, matching what Explorer and
 *  every provider's file-size column say. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

/** "M:SS.mmm" from a duration in seconds, for scrub/trim readouts. Clamps
 *  negatives and non-finite input to zero so a half-loaded video can't put
 *  "NaN:NaN" on screen. */
export function formatTimecode(sec: number): string {
  const t = Number.isFinite(sec) && sec > 0 ? sec : 0;
  // Round to whole milliseconds first — rounding the fraction separately
  // would let 1.9996 render as "0:01.1000".
  const total = Math.round(t * 1000);
  const ms = total % 1000;
  const whole = (total - ms) / 1000;
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}
