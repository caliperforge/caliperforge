import { defineConfig } from 'vitest/config'

export default defineConfig({
  // git-spawning suites take 1–3 s a test alone and passed 5 s under load on the laptop (#70)
  // three workers, not one per core: three lanes checking at once overran the cores and every git-spawning
  // test timed out together (#220, 2026-09-24: CPU 30% sys, load 15 on 10 cores)
  test: { testTimeout: 30_000, maxWorkers: 3, include: ['checks/*.test.ts', 'cli/tests/*.test.ts', 'store/*.test.ts', 'providers/**/tests/*.test.ts', 'runner/tests/*.test.ts', 'rails/*/tests/*.test.ts', 'seats/*/tests/*.test.ts', 'reviews/*/tests/*.test.ts', 'sequencer/tests/*.test.ts'] },
})
