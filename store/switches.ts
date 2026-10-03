import type { Db } from './index.ts'

export interface Switch { key: string; value: string | null; since: string }

const SHADOWS: Record<string, string> = { 'orchestrator.apply': '2026-09-22', 'coo_lite.apply': '2026-09-27' }

export function switches(db: Db): Switch[] {
  const rows = db.prepare("SELECT key, value, set_at AS since FROM settings WHERE key GLOB '*.apply'").all() as Switch[]
  const unset = Object.entries(SHADOWS).filter(([key]) => !rows.some((r) => r.key === key)).map(([key, since]) => ({ key, value: null, since }))
  return [...rows.filter((r) => r.value !== '1'), ...unset].sort((a, b) => a.key.localeCompare(b.key))
}
