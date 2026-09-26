declare const fired: { exit: number }
declare const a: string
declare const b: string

export const got = fired.exit === 0 ? a : b
