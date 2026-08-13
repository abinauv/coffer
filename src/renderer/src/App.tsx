/*
 * Application root.
 *
 * Placeholder until the renderer shell lands in Batch 0.2. The shell owns routing,
 * the title bar, the command palette and the company picker; this file will become
 * the composition point for those, and nothing more.
 */

import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { AppInfo } from '@shared/dto'

export function App(): JSX.Element {
  const [info, setInfo] = useState<AppInfo | null>(null)

  useEffect(() => {
    void window.coffer.system.getAppInfo().then((result) => {
      if (result.ok) setInfo(result.data)
    })
  }, [])

  return (
    <main className="boot">
      <h1>Coffer</h1>
      <p>Your books, in your own safe.</p>
      {info && (
        <p className="boot__meta">
          {info.version} · {info.platform}
        </p>
      )}
    </main>
  )
}
