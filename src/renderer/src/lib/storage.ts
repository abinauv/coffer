/*
 * A forgiving wrapper over `localStorage`.
 *
 * This holds interface preferences only — theme, sidebar state. Nothing about a
 * company, and certainly nothing derived from its books, is written here: the
 * books live in the encrypted database and reach the renderer only over IPC.
 *
 * Storage can throw (disabled, quota, a sandboxed context), and a preference that
 * cannot be saved is never a reason to fail an action, so every call swallows.
 */

/** The slice of the Storage API used here. Injectable so tests need no DOM. */
export interface PreferenceStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export function browserStore(): PreferenceStore | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

export function readPreference(store: PreferenceStore | null, key: string): string | null {
  if (!store) return null
  try {
    return store.getItem(key)
  } catch {
    return null
  }
}

export function writePreference(store: PreferenceStore | null, key: string, value: string): void {
  if (!store) return
  try {
    store.setItem(key, value)
  } catch {
    /* A preference we could not persist is a preference that resets next launch.
     * That is an acceptable outcome; failing the user's action is not. */
  }
}
