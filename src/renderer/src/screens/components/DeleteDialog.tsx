/*
 * Removing a record entirely — a party, an item, a unit — which is only ever right for one
 * nothing refers to.
 *
 * THE DIALOG REPEATS THE NAME OF THE THING (design system §03). A Delete button in a row of
 * forty looks like every other Delete button, and the title is where somebody who clicked
 * the wrong row finds out before anything is gone.
 *
 * THE REFUSAL IS SHOWN HERE rather than as a toast, because it is the answer to the question
 * this dialog asked, it names what is in the way, and archiving — the next thing to do — is
 * what the sentence under the title already offered. A toast slides past; this stays.
 */

import { useCallback, useState } from 'react'
import type { JSX } from 'react'
import { Button, Dialog } from '@renderer/components/atoms'
import type { AppError, Result } from '@shared/dto'
import { FailureNotice } from './FailureNotice'

interface DeleteDialogProps {
  /** What is being deleted, as its list names it. Null when nothing is. */
  name: string | null
  /** What deleting does and when it is refused, and what to do instead. */
  sentence: string
  onConfirm: () => Promise<Result<void>>
  onClose: () => void
  onDeleted: () => void
}

export function DeleteDialog({
  name,
  sentence,
  onConfirm,
  onClose,
  onDeleted,
}: DeleteDialogProps): JSX.Element {
  const [isBusy, setBusy] = useState(false)
  const [error, setError] = useState<AppError | null>(null)

  const submit = useCallback(async () => {
    setBusy(true)
    setError(null)
    const result = await onConfirm()
    setBusy(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    onDeleted()
  }, [onConfirm, onDeleted])

  return (
    <Dialog
      isOpen={name !== null}
      onClose={onClose}
      size="sm"
      title={name === null ? 'Delete this?' : `Delete ${name}?`}
      footer={
        <>
          <Button onClick={onClose}>Keep it</Button>
          <Button variant="danger" onClick={() => void submit()} isBusy={isBusy}>
            Delete
          </Button>
        </>
      }
    >
      <div className="stack">
        {error && <FailureNotice error={error} context="ledger" />}
        <p className="prose">{sentence}</p>
      </div>
    </Dialog>
  )
}
