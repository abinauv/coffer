/*
 * The bridge. Exposes exactly one object to the renderer: the typed API.
 *
 * Nothing else crosses. No Node globals, no `ipcRenderer`, no filesystem, no module
 * loading. If the renderer needs a new capability, it gets a new method on `CofferApi`
 * — not a widening of what is exposed here.
 *
 * The object itself is built in ./bridge.ts, which explains why it has to be a plain
 * object rather than the proxy handed straight over.
 */

import { contextBridge, ipcRenderer } from 'electron'
import { createBridgeApi } from './bridge'

const api = createBridgeApi(
  (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  /* The preload console is the renderer's devtools, on the user's own machine. This is
   * the one place the underlying IPC failure is visible; it never crosses to the page. */
  (message, cause) => console.error(message, cause),
)

contextBridge.exposeInMainWorld('coffer', api)
