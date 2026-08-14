import type { JSX } from 'react'
import { shortcutParts, type Shortcut } from '../../lib/keys'
import { usePlatform } from '../../store/platform'

interface KbdProps {
  shortcut: Shortcut
  className?: string
}

/**
 * Renders a shortcut as keycaps, in the notation the current platform uses:
 * ⇧⌘P on macOS, Ctrl+Shift+P everywhere else.
 */
export function Kbd({ shortcut, className }: KbdProps): JSX.Element {
  const platform = usePlatform()
  const parts = shortcutParts(shortcut, platform)

  return (
    <span className={['kbd', className ?? ''].filter(Boolean).join(' ')}>
      {parts.map((part, index) => (
        <kbd key={`${part}-${index}`} className="kbd__key">
          {part}
        </kbd>
      ))}
    </span>
  )
}
