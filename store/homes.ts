import { LANE, type Lane } from './lanes.ts'

const ALSO: Partial<Record<Lane, string[]>> = { machine: ['caliperforge/ledger-rig'], rubin: ['caliperforge/rubin-alert-monitor', 'caliperforge/neo-watch', 'caliperforge/sky-schema', 'caliperforge/sky-core', 'caliperforge/sky-ui'] }

export function homes(lane: Lane): string[] {
  return [LANE[lane].home, ...(ALSO[lane] ?? [])]
}
