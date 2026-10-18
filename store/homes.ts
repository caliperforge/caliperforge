import { LANE, type Lane } from './lanes.ts'

const ALSO: Partial<Record<Lane, string[]>> = { rubin: ['caliperforge/rubin-alert-monitor'] }

export function homes(lane: Lane): string[] {
  return [LANE[lane].home, ...(ALSO[lane] ?? [])]
}
