/** 10% off orders of 100 or more. */
export function discount(total: number): number {
  if (total >= 100) {
    return total * 0.9;
  }
  return total;
}
