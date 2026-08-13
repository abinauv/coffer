/*
 * The bridge. Exposes exactly one object to the renderer: the typed API proxy.
 *
 * Nothing else crosses. No Node globals, no `ipcRenderer`, no filesystem, no module
 * loading. If the renderer needs a new capability, it gets a new method on `CofferApi`
 * — not a widening of what is exposed here.
 */

import { contextBridge, ipcRenderer } from 'electron'
import { createApiProxy } from '../shared/ipc'

const api = createApiProxy((channel, ...args) => ipcRenderer.invoke(channel, ...args))

contextBridge.exposeInMainWorld('coffer', api)
