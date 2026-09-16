import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { include: ['checks/*.test.ts', 'store/*.test.ts'] },
})
