import type { CofferApi } from '../shared/ipc'

declare global {
  interface Window {
    /** The only bridge into the main process. See src/preload/index.ts. */
    coffer: CofferApi
  }
}

export {}
