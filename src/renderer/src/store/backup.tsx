/*
 * Backing up the open company.
 *
 * ONE FLOW, WHEREVER IT IS STARTED FROM. The rail's footer offers Back up now on every
 * workspace screen, the Overview offers it beside the sentence explaining why, and the
 * palette offers it by name. Three buttons with three copies of the flow would be three
 * busy states, and a second click on one while another was writing would start a second
 * archive. So the flow and its busy state live here, once, and all three read them.
 *
 * The command is registered here too, and only while a company is open: backing up the
 * books is meaningless from the picker.
 *
 * The wording comes from `screens/lib`, the one place a failure is put into words; those
 * modules are pure and import nothing from React.
 */

import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'
import type { JSX, ReactNode } from 'react'
import { describeFileSize } from '../screens/lib/dates'
import { failureTitle } from '../screens/lib/messages'
import { callApi } from '../lib/api'
import type { Command } from '../lib/command-registry'
import { useRegisterCommands } from './commands'
import { useCompany } from './company'
import { useToasts } from './toasts'

interface BackupContextValue {
  /** Asks where, writes the archive, and says what happened in a toast. */
  backUp: () => Promise<void>
  isBackingUp: boolean
}

const BackupContext = createContext<BackupContextValue | null>(null)

export function BackupProvider({ children }: { children: ReactNode }): JSX.Element {
  const { company, update } = useCompany()
  const { show } = useToasts()
  const [isBackingUp, setBackingUp] = useState(false)
  /* The state is for drawing; the ref is the guard. Two clicks inside one frame both see
   * `isBackingUp` false, and only the ref has already been set by the first. */
  const running = useRef(false)

  const backUp = useCallback(async () => {
    if (running.current) return
    running.current = true
    setBackingUp(true)
    try {
      const folder = await callApi((api) => api.system.chooseDirectory())
      if (!folder.ok) {
        show({ tone: 'danger', title: failureTitle(folder.error), body: folder.error.message })
        return
      }
      const directoryPath = folder.data
      if (directoryPath === null) return

      const result = await callApi((api) => api.companies.backup({ directoryPath }))
      if (!result.ok) {
        show({
          tone: 'danger',
          title: failureTitle(result.error, 'backup'),
          body: result.error.message,
        })
        return
      }

      /* Main remembered the archive in the registry and handed the company back with it.
       * Adopting it is what makes Company → Backups and the rail say "backed up today"
       * without asking again. */
      update(result.data.company)

      const archivePath = result.data.archivePath
      show({
        tone: 'success',
        title: 'Backup written',
        body: `${archivePath} · ${describeFileSize(result.data.sizeBytes)}. It holds the database and its vault. Keep a copy somewhere other than this machine.`,
        durationMs: null,
        action: {
          label: 'Show in folder',
          run: () => {
            void callApi((api) => api.system.revealInFileManager(archivePath))
          },
        },
      })
    } finally {
      running.current = false
      setBackingUp(false)
    }
  }, [show, update])

  useRegisterCommands(
    useMemo<Command[]>(
      () =>
        company === null
          ? []
          : [
              {
                id: 'company.backup',
                title: 'Back up this company',
                section: 'Company',
                keywords: ['archive', 'copy', 'safe'],
                isDisabled: isBackingUp,
                ...(isBackingUp ? { hint: 'Backing up…' } : {}),
                run: () => void backUp(),
              },
            ],
      [company, isBackingUp, backUp],
    ),
  )

  const value = useMemo<BackupContextValue>(() => ({ backUp, isBackingUp }), [backUp, isBackingUp])

  return <BackupContext.Provider value={value}>{children}</BackupContext.Provider>
}

export function useBackup(): BackupContextValue {
  const value = useContext(BackupContext)
  if (!value) throw new Error('useBackup must be used inside a BackupProvider')
  return value
}
