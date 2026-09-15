/*
 * Creating a company, in three steps: the company, the passphrase, the recovery codes.
 *
 * THE ONE DECISION THIS FLOW GETS RIGHT OR WRONG. The passphrase is not a login. There is
 * no escrow, no maintainer key and no reset (ARCHITECTURE §6.3.1) — so the flow says that
 * in plain words *before* the passphrase is chosen, warns loudly when the passphrase is
 * weak, and then gets out of the way. It never refuses one: a user who is refused their own
 * passphrase has nobody to appeal to, which is a worse failure than a weak passphrase
 * knowingly chosen.
 *
 * THREE STEPS, NOT ONE FORM, and nothing asked that can be filled in later from inside the
 * books. The company is created at the end of the second step, as it always was; the third
 * is the recovery codes, which cannot be skipped and have no Back.
 *
 * The GSTIN is optional and advisory here. It is put to the regime as it is typed, for the
 * hint under the box, and saved into Business details once the codes are dealt with
 * (RecoveryCodesStep). Nothing about creating the company waits on it.
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
import type {
  AppError,
  OpenCompanyResult,
  PassphraseStrength,
  RegistrationCheck,
} from '@shared/dto'
import { FailureNotice } from '../components/FailureNotice'
import { PassphraseField } from '../components/PassphraseField'
import { PathField } from '../components/PathField'
import { StepCard, StepFrame } from '../components/StepFrame'
import { StrengthMeter } from '../components/StrengthMeter'
import { needsWeakConfirmation, validateCreate } from '../lib/forms'
import {
  CREATE_STEPS,
  companyStepHint,
  confirmationHint,
  currentCheck,
  registrationError,
  registrationHint,
  registrationLabel,
} from '../lib/create-flow'
import { NO_RESET_WARNING, WEAK_CONFIRM_TITLE, weakConfirmBody } from '../lib/passphrase-meter'
import { RecoveryCodesStep } from './RecoveryCodesStep'

/** How long to wait after a keystroke before asking main to score or check something. */
const CHECK_DEBOUNCE_MS = 160

export function CreateCompany(): JSX.Element {
  const { navigate, back, canGoBack } = useNavigation()

  const [step, setStep] = useState<0 | 1>(0)
  const [displayName, setDisplayName] = useState('')
  const [registrationNumber, setRegistrationNumber] = useState('')
  const [registration, setRegistration] = useState<RegistrationCheck | null>(null)
  const [directoryPath, setDirectoryPath] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [hasTriedContinue, setTriedContinue] = useState(false)
  const [strength, setStrength] = useState<PassphraseStrength | null>(null)
  const [isBusy, setBusy] = useState(false)
  const [error, setError] = useState<AppError | null>(null)
  const [isWeakDialogOpen, setWeakDialogOpen] = useState(false)
  const [created, setCreated] = useState<OpenCompanyResult | null>(null)

  const form = validateCreate(
    { displayName, directoryPath, passphrase, confirmation },
    confirmation !== '',
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
    }, CHECK_DEBOUNCE_MS)
    return () => {
      isActive = false
      clearTimeout(handle)
    }
  }, [passphrase])

  /*
   * The same for the registration number, and asked once for a blank one on arrival: the
   * answer carries what the regime calls the number, which is the field's label. Nothing
   * waits on it — a check that fails leaves the field unlabelled by the regime, not
   * unusable.
   */
  useEffect(() => {
    let isActive = true
    const handle = setTimeout(
      () => {
        void callApi((api) => api.companies.checkRegistration({ registrationNumber })).then(
          (result) => {
            if (isActive && result.ok) setRegistration(result.data)
          },
        )
      },
      registrationNumber === '' ? 0 : CHECK_DEBOUNCE_MS,
    )
    return () => {
      isActive = false
      clearTimeout(handle)
    }
  }, [registrationNumber])

  /* A verdict about a number that has since been typed over is not a verdict about this one. */
  const current = currentCheck(registration, registrationNumber)
  const isRegistrationInvalid = current?.status === 'invalid'

  const isCompanyReady =
    displayName.trim() !== '' && directoryPath.trim() !== '' && !isRegistrationInvalid

  const chooseFolder = useCallback(async () => {
    const result = await callApi((api) => api.system.chooseDirectory())
    if (result.ok && result.data !== null) setDirectoryPath(result.data)
  }, [])

  const toCompanies = useCallback(
    () => (canGoBack ? back() : navigate(makeRoute('welcome', 'companies'))),
    [back, canGoBack, navigate],
  )

  const continueToPassphrase = useCallback(() => {
    setTriedContinue(true)
    if (isCompanyReady) setStep(1)
  }, [isCompanyReady])

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
    const saved = current?.status === 'valid' ? current.normalised : null
    return <RecoveryCodesStep result={created} registrationNumber={saved} />
  }

  if (step === 0) {
    return (
      <StepFrame
        flowLabel="Creating a company"
        steps={CREATE_STEPS}
        current={0}
        title="Create a company"
        lede="Everything here can be changed later, except where the files are kept — and you can move those yourself, like any other file."
        aside={
          <StepCard title="What creating the company does">
            <ol className="step-card__list">
              <li>
                Two files are written in the folder you choose: the encrypted books, and the vault
                holding their key. Nothing is sent anywhere.
              </li>
              <li>
                A chart of accounts, a year of periods and numbering for every kind of document are
                set up inside.
              </li>
              <li>You choose a passphrase. It is the only key, and it is not stored.</li>
              <li>Five recovery codes are shown once, and never again.</li>
            </ol>
          </StepCard>
        }
        back={
          <Button variant="ghost" icon="chevron-left" onClick={toCompanies}>
            All companies
          </Button>
        }
        hint={companyStepHint({ displayName, directoryPath, isRegistrationInvalid })}
        primary={
          <Button
            variant="primary"
            iconEnd="arrow-right"
            onClick={continueToPassphrase}
            disabled={!isCompanyReady}
          >
            Continue
          </Button>
        }
      >
        <div className="stack">
          <Input
            label="Business name"
            value={displayName}
            error={hasTriedContinue ? form.errors.displayName : undefined}
            hint="As it should appear on your invoices. It names the file, and you can change it later."
            maxLength={120}
            autoFocus
            onChange={(event) => setDisplayName(event.target.value)}
          />

          <Input
            label={registrationLabel(registration)}
            value={registrationNumber}
            isIdentifier
            autoComplete="off"
            spellCheck={false}
            maxLength={32}
            error={registrationError(current)}
            hint={registrationHint(current)}
            onChange={(event) => setRegistrationNumber(event.target.value)}
          />

          <PathField
            label="Keep the files in"
            value={directoryPath}
            placeholder="No folder chosen"
            buttonLabel="Choose folder"
            onChoose={() => void chooseFolder()}
            error={hasTriedContinue ? form.errors.directoryPath : undefined}
            hint="The books and their vault go here, side by side. Somewhere you back up — not a temporary folder."
          />
        </div>
      </StepFrame>
    )
  }

  return (
    <StepFrame
      flowLabel="Creating a company"
      steps={CREATE_STEPS}
      current={1}
      title="Choose a passphrase"
      lede="This encrypts the books. It is not stored anywhere, so Coffer cannot reset it and neither can anyone else. Four ordinary words you will not forget beat one clever word you might."
      aside={
        <>
          <StepCard title="How this is protected">
            <p>
              Your passphrase is stretched with Argon2id on this computer and never leaves it. The
              books are an SQLCipher database, and the key that opens them lives only in the vault
              beside them.
            </p>
          </StepCard>
          <StepCard title="There is no back door" tone="warning">
            <p>
              If you lose this passphrase and all five recovery codes, these books cannot be opened
              by anyone — including the people who wrote Coffer. That is deliberate, and it is why
              the next step exists.
            </p>
          </StepCard>
        </>
      }
      back={
        <Button variant="ghost" icon="chevron-left" onClick={() => setStep(0)} disabled={isBusy}>
          Back
        </Button>
      }
      hint={
        isBusy
          ? 'Creating takes a moment: the key is deliberately slow to derive.'
          : confirmationHint({ passphrase, confirmation })
      }
      primary={
        <Button
          variant="primary"
          icon="plus"
          onClick={() => void submit(false)}
          disabled={!form.canSubmit}
          isBusy={isBusy}
        >
          Create the company
        </Button>
      }
    >
      <div className="stack">
        {error && <FailureNotice error={error} context="create" />}

        <PassphraseField
          label="Passphrase"
          value={passphrase}
          onChange={setPassphrase}
          autoFocus
          isDisabled={isBusy}
          onSubmit={() => void submit(false)}
        >
          <StrengthMeter strength={strength} passphrase={passphrase} />
        </PassphraseField>

        <PassphraseField
          label="Type it again"
          value={confirmation}
          onChange={setConfirmation}
          error={form.errors.confirmation}
          hint={
            confirmation === ''
              ? 'Typing it twice catches a mistake now rather than on the day you need it.'
              : 'Both match.'
          }
          isDisabled={isBusy}
          onSubmit={() => void submit(false)}
        />
      </div>

      <WeakPassphraseDialog
        isOpen={isWeakDialogOpen}
        strength={strength}
        onClose={() => setWeakDialogOpen(false)}
        onProceed={() => void submit(true)}
      />
    </StepFrame>
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
