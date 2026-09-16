/*
 * Restoring a backup, from wherever it is asked for.
 *
 * The picker offers it to somebody who has no company open; Company → Backups offers it to
 * somebody who has. The flow is identical and must stay so — restoring NEVER touches the
 * company that is open. It writes the archive's two files into a folder the user picks and
 * adds a row to the list, so a restored company is a SEPARATE company, sitting beside the
 * one it was copied from. Nothing is overwritten, and nothing is opened: restoring proves
 * nothing about who is holding the passphrase.
 */

import { useCallback, useState } from 'react'
import type { JSX } from 'react'
import { Button, Dialog } from '@renderer/components/atoms'
import { callApi } from '@renderer/lib/api'
import { useToasts } from '@renderer/store/toasts'
import { failureTitle } from '../lib/messages'
import { validateRestore } from '../lib/forms'
import { Notice } from './Notice'
import { PathField } from './PathField'

interface RestoreDialogProps {
  isOpen: boolean
  onClose: () => void
  onDone: () => Promise<void>
}

export function RestoreDialog({ isOpen, onClose, onDone }: RestoreDialogProps): JSX.Element {
  const { show } = useToasts()
  const [archivePath, setArchivePath] = useState('')
  const [directoryPath, setDirectoryPath] = useState('')
  const [isBusy, setBusy] = useState(false)
  const state = validateRestore({ archivePath, directoryPath })

  const close = useCallback(() => {
    setArchivePath('')
    setDirectoryPath('')
    onClose()
  }, [onClose])

  const chooseArchive = useCallback(async () => {
    const result = await callApi((api) => api.system.chooseBackupArchive())
    if (result.ok && result.data !== null) setArchivePath(result.data)
  }, [])

  const chooseFolder = useCallback(async () => {
    const result = await callApi((api) => api.system.chooseDirectory())
    if (result.ok && result.data !== null) setDirectoryPath(result.data)
  }, [])

  const submit = useCallback(async () => {
    if (!state.canSubmit) return
    setBusy(true)
    const result = await callApi((api) => api.companies.restore({ archivePath, directoryPath }))
    setBusy(false)
    if (!result.ok) {
      show({
        tone: 'danger',
        title: failureTitle(result.error, 'restore'),
        body: result.error.message,
      })
      return
    }
    await onDone()
    close()
    show({
      tone: 'success',
      title: `${result.data.displayName} was restored`,
      body: 'Open it with the passphrase it had when the backup was taken. Recovery codes from that time still work.',
    })
  }, [state.canSubmit, archivePath, directoryPath, show, onDone, close])

  return (
    <Dialog
      isOpen={isOpen}
      onClose={close}
      title="Restore from a backup"
      description="A Coffer backup holds the database and its vault together. Both are written out, and neither replaces anything that is already there."
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button
            variant="primary"
            onClick={() => void submit()}
            disabled={!state.canSubmit}
            isBusy={isBusy}
          >
            Restore
          </Button>
        </>
      }
    >
      <div className="stack">
        <PathField
          label="Backup archive"
          value={archivePath}
          placeholder="No archive chosen"
          buttonLabel="Choose archive"
          onChoose={() => void chooseArchive()}
          hint="The file Coffer wrote, ending in .coffer-backup.zip."
        />
        <PathField
          label="Restore into"
          value={directoryPath}
          placeholder="No folder chosen"
          buttonLabel="Choose folder"
          onChoose={() => void chooseFolder()}
          hint="Choose an empty folder. Coffer will not write over a company that is already there."
        />
        <Notice tone="info">
          <p>
            Restoring does not open the company: it puts the files back and adds them to your list.
            You still need the passphrase from the day the backup was taken.
          </p>
        </Notice>
      </div>
    </Dialog>
  )
}
