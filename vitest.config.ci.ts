import { defineConfig, mergeConfig } from 'vitest/config'

import baseConfig from './vitest.config'

// CI hosted runners:
// - threads pool (no child processes): native-module aborts surface as normal
//   stack traces instead of silently killing fork workers.
// - serialize files: memory spikes + shared userData dirs in tests.
export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      pool: 'threads',
      fileParallelism: false,
      maxWorkers: 1,
      minWorkers: 1,
    },
  }),
)
