import { defineConfig, mergeConfig } from 'vitest/config'

import baseConfig from './vitest.config'

// CI hosted runners: serialize files (native modules + memory spikes),
// and keep electron out of the test runtime entirely (ELECTRON_SKIP_BINARY_DOWNLOAD=1 in ci.yml).
export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      fileParallelism: false,
    },
  }),
)
