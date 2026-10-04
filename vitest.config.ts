import { defineConfig } from 'vitest/config'

export default defineConfig({
  // a git-spawning test takes 1–3 s alone and over 5 s under load
  // three workers, not one per core: three lanes checking at once overrun the cores and every git-spawning
  // test times out
  test: { testTimeout: 30_000, maxWorkers: 3, globalSetup: ['sequencer/tests/bases.ts'], include: ['checks/*.test.ts', 'cli/tests/*.test.ts', 'store/*.test.ts', 'providers/**/tests/*.test.ts', 'runner/tests/*.test.ts', 'rails/*/tests/*.test.ts', 'seats/*/tests/*.test.ts', 'reviews/*/tests/*.test.ts', 'sequencer/tests/*.test.ts', 'rules/tests/*.test.ts'] },
})
