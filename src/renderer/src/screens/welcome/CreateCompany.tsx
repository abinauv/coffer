/*
 * Creating a company: a name, a folder, and the passphrase that encrypts everything that
 * will ever be written into it.
 *
 * THE ONE DECISION THIS SCREEN GETS RIGHT OR WRONG. The passphrase is not a login. There
 * is no escrow, no maintainer key and no reset (ARCHITECTURE §6.3.1) — so the screen has
 * to say that in plain words *before* the passphrase is chosen, warn loudly when the
 * passphrase is weak, and then get out of the way. It never refuses one: a user who is
 * refused their own passphrase has nobody to appeal to, which is a worse failure than a
 * weak passphrase knowingly chosen.
 *
 * The passphrase lives in this component's state and nowhere else. It is not persisted,
 * not put in a route, not logged, and it is cleared the moment main has taken it.
 */

import { useCallback, useEffect, useState } from 'react'
import type { JSX } from 'react'
import { Button, Dialog, Input } from '@renderer/components/atoms'
import { callApi } from '@renderer/lib/api'
import { makeRoute } from '@renderer/lib/routing'
import { useNavigation } from '@renderer/store/navigation'
import { registerScreens } from '@renderer/lib/screens'
import type { AppError, OpenCompanyResult, PassphraseStrength } from '@shared/dto'
import { FailureNotice } from '../components/FailureNotice'
import { Notice } from '../components/Notice'
import { PassphraseField } from '../components/PassphraseField'
import { PathField } from '../components/PathField'
import { ScreenFrame } from '../components/ScreenFrame'
import { StrengthMeter } from '../components/StrengthMeter'
import { needsWeakConfirmation, validateCreate } from '../lib/forms'
import { NO_RESET_WARNING, WEAK_CONFIRM_TITLE, weakConfirmBody } from '../lib/passphrase-meter'
import { RecoveryCodesStep } from './RecoveryCodesStep'

/** How long to wait after a keystroke before asking main to score the passphrase. */
const STRENGTH_DEBOUNCE_MS = 160

export function CreateCompany(): JSX.Element {
  const { navigate, back, canGoBack } = useNavigation()

  const [displayName, setDisplayName] = useState('')
  const [directoryPath, setDirectoryPath] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [hasTouchedConfirmation, setTouchedConfirmation] = useState(false)
  const [strength, setStrength] = useState<PassphraseStrength | null>(null)
  const [isBusy, setBusy] = useState(false)
  const [error, setError] = useState<AppError | null>(null)
  const [isWeakDialogOpen, setWeakDialogOpen] = useState(false)
  const [created, setCreated] = useState<OpenCompanyResult | null>(null)

  const form = validateCreate(
    { displayName, directoryPath, passphrase, confirmation },
    hasTouchedConfirmation,
  )

  /*
   * Scoring happens in main and costs an IPC round trip, so it is debounced — and the
   * meter shows nothing rather than a stale verdict while it waits. `isActive` drops the
   * answer to a passphrase that has already been typed over.
   */
  useEffect(() => {
    if (passphrase === '') {
      setStrength(null)
      return undefined
    }
    let isActive = true
    const handle = setTimeout(() => {
      void callApi((api) => api.companies.checkPassphrase(passphrase)).then((result) => {
        if (isActive && result.ok) setStrength(result.data)
      })
    }, STRENGTH_DEBOUNCE_MS)
    return () => {
      isActive = false
      clearTimeout(handle)
    }
  }, [passphrase])

  const chooseFolder = useCallback(async () => {
    const result = await callApi((api) => api.system.chooseDirectory())
    if (result.ok && result.data !== null) setDirectoryPath(result.data)
  }, [])

  const submit = useCallback(
    async (hasConfirmedWeak: boolean) => {
      if (!form.canSubmit || isBusy) return
      if (needsWeakConfirmation(strength, hasConfirmedWeak)) {
        setWeakDialogOpen(true)
        return
      }

      setWeakDialogOpen(false)
      setBusy(true)
      setError(null)
      const result = await callApi((api) =>
        api.companies.create({ displayName: displayName.trim(), directoryPath, passphrase }),
      )
      setBusy(false)

      if (!result.ok) {
        setError(result.error)
        return
      }

      /* Main has the passphrase now and this window has no further use for it. */
      setPassphrase('')
      setConfirmation('')
      setCreated(result.data)
    },
    [form.canSubmit, isBusy, strength, displayName, directoryPath, passphrase],
  )

  /*
   * The company is open in main from the moment `create` returns — but the shell only
   * switches to the workspace when the renderer adopts the result, and that does not
   * happen until the recovery codes have been saved. They are shown exactly once and
   * cannot be recovered afterwards, so nothing is allowed to navigate past them.
   */
  if (created !== null) {
    return <RecoveryCodesStep result={created} />
  }

  return (
    <ScreenFrame
      title="Create a company"
      lede="Coffer writes two files: the encrypted database, and the vault holding its keys. They belong together, and a backup is the only thing that keeps them that way."
      back={{
        label: 'All companies',
        onClick: () => (canGoBack ? back() : navigate(makeRoute('welcome', 'companies'))),
      }}
    >
      <div className="stack">
        {error && <FailureNotice error={error} context="create" />}

        <Input
          label="Company name"
          value={displayName}
          error={form.errors.displayName}
          hint="Used for the file name and shown in your list. You can change it later."
          maxLength={120}
          autoFocus
          onChange={(event) => setDisplayName(event.target.value)}
        />

        <PathField
          label="Keep it in"
          value={directoryPath}
          placeholder="No folder chosen"
          buttonLabel="Choose folder"
          onChoose={() => void chooseFolder()}
          error={form.errors.directoryPath}
          hint="Both files go here, side by side. Somewhere you back up — not a temporary folder."
        />

        <PassphraseField
          label="Passphrase"
          value={passphrase}
          onChange={setPassphrase}
          error={form.errors.passphrase}
          hint="Four unrelated words you will not forget beats one clever word you might."
          onSubmit={() => void submit(false)}
        >
          <StrengthMeter strength={strength} passphrase={passphrase} />
        </PassphraseField>

        <PassphraseField
          label="Passphrase again"
          value={confirmation}
          onChange={(value) => {
            setConfirmation(value)
            setTouchedConfirmation(true)
          }}
          error={form.errors.confirmation}
          hint="Typed twice because a typo here is unrecoverable, not because we do not trust you."
          onSubmit={() => void submit(false)}
        />

        <Notice tone="warning" title="This passphrase cannot be reset">
          <p>{NO_RESET_WARNING}</p>
          <p>
            When the company is created, Coffer shows five recovery codes — once. They are the only
            way back in if the passphrase is lost, so have somewhere to write them down before you
            continue.
          </p>
        </Notice>

        <div className="actions">
          <Button
            variant="primary"
            icon="plus"
            onClick={() => void submit(false)}
            disabled={!form.canSubmit}
            isBusy={isBusy}
          >
            Create company
          </Button>
          <p className="actions__note">
            Creating takes a moment: the key is deliberately slow to derive.
          </p>
        </div>
      </div>

      <WeakPassphraseDialog
        isOpen={isWeakDialogOpen}
        strength={strength}
        onClose={() => setWeakDialogOpen(false)}
        onProceed={() => void submit(true)}
      />
    </ScreenFrame>
  )
}

interface WeakDialogProps {
  isOpen: boolean
  strength: PassphraseStrength | null
  onClose: () => void
  onProceed: () => void
}

/**
 * The one interruption a weak passphrase earns.
 *
 * It states the cost and offers both doors. "Use it anyway" is a real button, not a
 * grudging one — SECURITY.md puts weak passphrases chosen by the user out of scope, and
 * puts accepting one *without warning* firmly in it. This is the warning.
 */
function WeakPassphraseDialog({
  isOpen,
  strength,
  onClose,
  onProceed,
}: WeakDialogProps): JSX.Element {
  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      title={WEAK_CONFIRM_TITLE}
      size="sm"
      footer={
        <>
          <Button variant="primary" onClick={onClose}>
            Choose a stronger one
          </Button>
          <Button onClick={onProceed}>Use it anyway</Button>
        </>
      }
    >
      <p className="prose">{weakConfirmBody(strength)}</p>
      {strength !== null && strength.suggestion !== null && (
        <p className="prose prose--muted">{strength.suggestion}</p>
      )}
      <p className="prose">{NO_RESET_WARNING}</p>
    </Dialog>
  )
}

registerScreens([
  {
    id: 'create',
    title: 'Create a company',
    area: 'welcome',
    render: () => <CreateCompany />,
  },
])
