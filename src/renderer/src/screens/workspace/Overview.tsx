/*
 * The workspace landing screen — a placeholder, and honest about it.
 *
 * Phase 1 brings the ledger, invoices and reports. What is here now is the part that
 * cannot wait for them: proof the right company is open, the backup that makes the
 * encryption survivable, a way to change the passphrase, and a way to close.
 *
 * Backup is the one that matters most. A company is a database and a sidecar vault
 * (ARCHITECTURE §6.3), so copying the file alone produces something nobody can ever open
 * again. `companies.backup` writes one archive holding both, and this screen never
 * suggests any other way of keeping a copy.
 */

import { useCallback, useMemo, useState } from 'react'
import type { JSX } from 'react'
import { Badge, Button, Dialog } from '@renderer/components/atoms'
import { callApi } from '@renderer/lib/api'
import type { Command } from '@renderer/lib/command-registry'
import { useRegisterCommands } from '@renderer/store/commands'
import { useCompany } from '@renderer/store/company'
import { registerScreens } from '@renderer/lib/screens'
import { useToasts } from '@renderer/store/toasts'
import type { AppError, PassphraseStrength } from '@shared/dto'
import { FailureNotice } from '../components/FailureNotice'
import { Notice } from '../components/Notice'
import { PassphraseField } from '../components/PassphraseField'
import { ScreenFrame } from '../components/ScreenFrame'
import { StrengthMeter } from '../components/StrengthMeter'
import { describeCreated, describeFileSize, describeLastOpened } from '../lib/dates'
import { validateChangePassphrase } from '../lib/forms'
import { failureTitle } from '../lib/messages'
import { NO_RESET_WARNING } from '../lib/passphrase-meter'

export function Overview(): JSX.Element {
  const { company, recoveryCodesRemaining, close } = useCompany()
  const { show } = useToasts()
  const [isBackingUp, setBackingUp] = useState(false)
  const [isPassphraseOpen, setPassphraseOpen] = useState(false)

  const backup = useCallback(async () => {
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
      setBackingUp(false)
    }
  }, [show])

  const closeCompany = useCallback(async () => {
    const result = await close()
    if (!result.ok) {
      show({
        tone: 'danger',
        title: failureTitle(result.error),
        body: result.error.message,
      })
    }
  }, [close, show])

  useRegisterCommands(
    useMemo<Command[]>(
      () => [
        {
          id: 'company.backup',
          title: 'Back up this company',
          section: 'Company',
          keywords: ['archive', 'copy', 'safe'],
          run: () => void backup(),
        },
        {
          id: 'company.change-passphrase',
          title: 'Change the passphrase',
          section: 'Company',
          keywords: ['password', 'key', 'security'],
          run: () => setPassphraseOpen(true),
        },
      ],
      [backup],
    ),
  )

  if (company === null) {
    /* The shell returns to the picker when no company is open, so this is a frame between
     * one state and the next rather than a state a user sits in. */
    return (
      <ScreenFrame title="No company is open" isInset>
        <p className="prose prose--muted">Returning to your companies…</p>
      </ScreenFrame>
    )
  }

  return (
    <ScreenFrame
      isInset
      title={company.displayName}
      lede="Open, decrypted in memory only, and readable by nothing else while it is."
      actions={
        <>
          <Button icon="archive" onClick={() => void backup()} isBusy={isBackingUp}>
            Back up now
          </Button>
          <Button icon="lock" onClick={() => setPassphraseOpen(true)}>
            Change passphrase
          </Button>
          <Button icon="close" onClick={() => void closeCompany()}>
            Close company
          </Button>
        </>
      }
    >
      <div className="stack">
        <section className="facts">
          <Fact label="Company file" value={company.filePath} isPath />
          <Fact label="Key vault" value={company.vaultPath} isPath />
          <Fact label="Last opened" value={describeLastOpened(company.lastOpenedAt)} />
          <Fact label="Created" value={describeCreated(company.createdAt)} />
          <Fact
            label="Recovery codes left"
            value={
              recoveryCodesRemaining === 0
                ? 'None — the passphrase is the only way in'
                : `${recoveryCodesRemaining} unused`
            }
            badge={
              recoveryCodesRemaining === 0 ? (
                <Badge tone="negative">None left</Badge>
              ) : recoveryCodesRemaining <= 2 ? (
                <Badge tone="warning">Running low</Badge>
              ) : null
            }
          />
        </section>

        {recoveryCodesRemaining === 0 && (
          <Notice tone="warning" title="No recovery codes remain">
            <p>
              Every code issued for this company has been spent. The passphrase is now the only way
              in, and nobody can reset it. Keep a backup, and keep the passphrase somewhere you will
              still have it in a year.
            </p>
          </Notice>
        )}

        <Notice tone="info" title="The books themselves arrive in the next phase" icon="ledger">
          <p>
            Accounts, invoices, purchases, inventory and reports are Phase 1. What works today is
            everything around them: the company file, its keys, backup and restore. Nothing you
            create now will be migrated away — this screen is a landing pad, not a prototype of one.
          </p>
        </Notice>
      </div>

      <ChangePassphraseDialog
        key={isPassphraseOpen ? 'open' : 'closed'}
        isOpen={isPassphraseOpen}
        onClose={() => setPassphraseOpen(false)}
      />
    </ScreenFrame>
  )
}

interface FactProps {
  label: string
  value: string
  isPath?: boolean
  badge?: JSX.Element | null
}

function Fact({ label, value, isPath = false, badge }: FactProps): JSX.Element {
  return (
    <div className="fact">
      <span className="fact__label caps-label">{label}</span>
      <span className={`fact__value ${isPath ? 'fact__value--path selectable truncate' : ''}`}>
        {value}
        {badge}
      </span>
    </div>
  )
}

// ---- Changing the passphrase ----------------------------------------------

interface ChangePassphraseDialogProps {
  isOpen: boolean
  onClose: () => void
}

/**
 * Re-wraps the key under a new passphrase.
 *
 * The database is not re-encrypted and the open session stays valid — main only rewrites
 * one slot in the vault. Every recovery code still works afterwards, which is worth
 * saying on screen: users expect changing a password to invalidate everything.
 */
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

registerScreens([
  {
    id: 'overview',
    title: 'Overview',
    area: 'workspace',
    nav: { label: 'Overview', icon: 'ledger', group: 'work', order: 0 },
    render: () => <Overview />,
  },
])
