/*
 * Changing the open company's passphrase, from anywhere in the workspace.
 *
 * IT LIVED ON THE OVERVIEW, AS A BUTTON AND A COMMAND THAT EXISTED ONLY WHILE THE OVERVIEW
 * WAS MOUNTED. The redesign gives that screen to the business, and the company's own
 * actions go where a company action belongs: the palette, which is reachable from every
 * screen. So the command is registered here for as long as a company is open, and the
 * dialog is drawn here, once — mounted beside the shell rather than inside any screen.
 *
 * The dialog re-wraps the key under a new passphrase. The database is not re-encrypted and
 * the open session stays valid — main only rewrites one slot in the vault. Every recovery
 * code still works afterwards, which is worth saying on screen: people expect changing a
 * password to invalidate everything.
 */

import { useCallback, useMemo, useState } from 'react'
import type { JSX } from 'react'
import { Button, Dialog } from '@renderer/components/atoms'
import { callApi } from '@renderer/lib/api'
import type { Command } from '@renderer/lib/command-registry'
import { useRegisterCommands } from '@renderer/store/commands'
import { useCompany } from '@renderer/store/company'
import { useToasts } from '@renderer/store/toasts'
import type { AppError, PassphraseStrength } from '@shared/dto'
import { validateChangePassphrase } from '../lib/forms'
import { NO_RESET_WARNING } from '../lib/passphrase-meter'
import { FailureNotice } from './FailureNotice'
import { Notice } from './Notice'
import { PassphraseField } from './PassphraseField'
import { StrengthMeter } from './StrengthMeter'

export function ChangePassphrase(): JSX.Element {
  const { company } = useCompany()
  const [isOpen, setOpen] = useState(false)

  useRegisterCommands(
    useMemo<Command[]>(
      () =>
        company === null
          ? []
          : [
              {
                id: 'company.change-passphrase',
                title: 'Change the passphrase',
                section: 'Company',
                keywords: ['password', 'key', 'security'],
                run: () => setOpen(true),
              },
            ],
      [company],
    ),
  )

  /* Keyed on open, so every opening starts with empty fields: a dialog that kept the last
   * attempt's passphrases in memory after it closed would be holding them for nothing. */
  return (
    <ChangePassphraseDialog
      key={isOpen ? 'open' : 'closed'}
      isOpen={isOpen && company !== null}
      onClose={() => setOpen(false)}
    />
  )
}

interface ChangePassphraseDialogProps {
  isOpen: boolean
  onClose: () => void
}

function ChangePassphraseDialog({ isOpen, onClose }: ChangePassphraseDialogProps): JSX.Element {
  const { show } = useToasts()
  const [currentPassphrase, setCurrent] = useState('')
  const [newPassphrase, setNew] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [hasTouchedConfirmation, setTouchedConfirmation] = useState(false)
  const [strength, setStrength] = useState<PassphraseStrength | null>(null)
  const [isBusy, setBusy] = useState(false)
  const [error, setError] = useState<AppError | null>(null)

  const form = validateChangePassphrase(
    { currentPassphrase, newPassphrase, confirmation },
    hasTouchedConfirmation,
  )

  const checkStrength = useCallback(async (value: string) => {
    if (value === '') {
      setStrength(null)
      return
    }
    const result = await callApi((api) => api.companies.checkPassphrase(value))
    if (result.ok) setStrength(result.data)
  }, [])

  const submit = useCallback(async () => {
    if (!form.canSubmit || isBusy) return
    setBusy(true)
    setError(null)
    const result = await callApi((api) =>
      api.companies.changePassphrase({ currentPassphrase, newPassphrase }),
    )
    setBusy(false)

    if (!result.ok) {
      setError(result.error)
      return
    }

    setCurrent('')
    setNew('')
    setConfirmation('')
    onClose()
    show({
      tone: 'success',
      title: 'Passphrase changed',
      body: 'Use the new one from now on. Your recovery codes are unaffected — they open this company regardless of which passphrase is set.',
    })
  }, [form.canSubmit, isBusy, currentPassphrase, newPassphrase, onClose, show])

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      /* A plain boolean, never the text: nothing may hold a second copy of a passphrase.
       * See `useHasTyped`, which the other dialogs use and this one must not. */
      hasUnsavedInput={currentPassphrase !== '' || newPassphrase !== '' || confirmation !== ''}
      title="Change the passphrase"
      description="This re-wraps the key. The books are not re-encrypted, nothing is re-saved, and every recovery code keeps working."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={() => void submit()}
            disabled={!form.canSubmit}
            isBusy={isBusy}
          >
            Change passphrase
          </Button>
        </>
      }
    >
      <div className="stack">
        {error && <FailureNotice error={error} context="change-passphrase" />}

        <PassphraseField
          label="Current passphrase"
          value={currentPassphrase}
          onChange={setCurrent}
          error={form.errors.currentPassphrase}
          isDisabled={isBusy}
        />

        <PassphraseField
          label="New passphrase"
          value={newPassphrase}
          onChange={(value) => {
            setNew(value)
            void checkStrength(value)
          }}
          error={form.errors.newPassphrase}
          isDisabled={isBusy}
        >
          <StrengthMeter strength={strength} passphrase={newPassphrase} />
        </PassphraseField>

        <PassphraseField
          label="New passphrase again"
          value={confirmation}
          onChange={(value) => {
            setConfirmation(value)
            setTouchedConfirmation(true)
          }}
          error={form.errors.confirmation}
          isDisabled={isBusy}
          onSubmit={() => void submit()}
        />

        <Notice tone="warning" title="Still nobody's to reset">
          <p>{NO_RESET_WARNING}</p>
        </Notice>
      </div>
    </Dialog>
  )
}
