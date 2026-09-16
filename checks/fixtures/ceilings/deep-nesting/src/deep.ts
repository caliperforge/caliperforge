export function pick(a: boolean, b: boolean, c: boolean, d: boolean): number {
  if (a) {
    if (b) {
      if (c) {
        if (d) return 4
      }
    }
  }
  return 0
}
