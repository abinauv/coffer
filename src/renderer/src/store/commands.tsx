/*
 * Command state.
 *
 * Two responsibilities: hold the registry, and be the one place in the product
 * that listens for a keyboard shortcut. Because shortcuts are declared on the
 * commands themselves, "what does Ctrl+K do" has exactly one answer and it is
 * discoverable in the palette — there is no second listener anywhere to drift
 * from the menu or the palette label.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import type { JSX, ReactNode } from 'react'
import { createCommandRegistry, type Command, type CommandRegistry } from '../lib/command-registry'
import { matchesShortcut, shouldIgnoreWhileTyping } from '../lib/keys'
import { usePlatform } from './platform'

interface CommandContextValue {
  commands: readonly Command[]
  registry: CommandRegistry
  /** Runs a command by id. Silently ignores unknown or disabled commands. */
  run: (id: string) => void
  isPaletteOpen: boolean
  setPaletteOpen: (isOpen: boolean) => void
}

const CommandContext = createContext<CommandContextValue | null>(null)

export function CommandProvider({ children }: { children: ReactNode }): JSX.Element {
  const [registry] = useState(createCommandRegistry)
  const [isPaletteOpen, setPaletteOpen] = useState(false)
  const platform = usePlatform()

  const commands = useSyncExternalStore(registry.subscribe, registry.list, registry.list)

  const run = useCallback(
    (id: string) => {
      const command = registry.find(id)
      if (!command || command.isDisabled === true) return
      void command.run()
    },
    [registry],
  )

  /* The listener reads the registry through a ref so it is installed once and
   * never torn down and rebuilt as screens register and unregister commands. */
  const latest = useRef({ commands, platform })
  latest.current = { commands, platform }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.defaultPrevented || event.repeat) return
      const { commands: available, platform: current } = latest.current

      for (const command of available) {
        if (!command.shortcut) continue
        if (!matchesShortcut(command.shortcut, event, current)) continue
        if (shouldIgnoreWhileTyping(command.shortcut, asTarget(event.target))) continue
        if (command.isDisabled === true) return
        event.preventDefault()
        void command.run()
        return
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const value = useMemo<CommandContextValue>(
    () => ({ commands, registry, run, isPaletteOpen, setPaletteOpen }),
    [commands, registry, run, isPaletteOpen],
  )

  return <CommandContext.Provider value={value}>{children}</CommandContext.Provider>
}

function asTarget(target: EventTarget | null): { tagName?: string; isContentEditable?: boolean } {
  if (!(target instanceof HTMLElement)) return {}
  return { tagName: target.tagName, isContentEditable: target.isContentEditable }
}

export function useCommands(): CommandContextValue {
  const value = useContext(CommandContext)
  if (!value) throw new Error('useCommands must be used inside a CommandProvider')
  return value
}

/**
 * Contributes commands for as long as the caller is mounted.
 *
 *   useRegisterCommands(useMemo(() => [{ id: …, run: … }], [dependency]))
 *
 * The array must be stable — a fresh array on every render would re-register on
 * every render. Memoise it at the call site, where the real dependencies are.
 */
export function useRegisterCommands(commands: readonly Command[]): void {
  const { registry } = useCommands()
  useEffect(() => registry.register(commands), [registry, commands])
}
