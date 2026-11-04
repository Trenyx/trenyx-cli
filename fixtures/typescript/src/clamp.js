/** Keep value between low and high. */
export function clamp(value, low, high) {
  return Math.max(low, Math.min(value, high));
}
