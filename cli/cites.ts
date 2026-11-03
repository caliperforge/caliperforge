export function cites(text: string, repo: string, no: number): boolean {
  const escaped = escape(repo)
  return new RegExp(`(?:${escaped}#|https://github\\.com/${escaped}/issues/)${String(no)}(?!\\d)`, 'i').test(text)
}

export function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
