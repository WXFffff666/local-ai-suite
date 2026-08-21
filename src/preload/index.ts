import { contextBridge } from 'electron'

// Minimal preload: expose version for smoke test. IPC will be expanded in later tasks.
const api = {
  ping: (): string => 'pong',
  versions: (): NodeJS.ProcessVersions => process.versions
}

contextBridge.exposeInMainWorld('api', api)

export type WindowApi = typeof api
