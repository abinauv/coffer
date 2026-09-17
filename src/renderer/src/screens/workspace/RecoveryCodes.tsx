/*
 * Company → Recovery codes.
 *
 * A recovery code opens these books once without the passphrase, and makes the user set a
 * new one on the spot. Five are issued when a company is created and shown exactly once.
 * Until now that was the end of it: a user who had spent four, or lost the sheet, or
 * handed a copy to somebody who no longer works there, had no way to start again.
 *
 * WHAT THIS SCREEN KNOWS, AND WHAT IT DOES NOT. It knows how many codes are unspent, and
 * nothing else. It cannot show a code, cannot say whether the sheet still exists, and
 * cannot tell a spent code from a lost one — the vault keeps a one-way verifier of each
 * code and no copy of any (ARCHITECTURE §6.3.1). So the screen reports the count, and
 * every other question is the user's to answer.
 *
 * ISSUING NEEDS THE PASSPHRASE, although a company is open. Five new ways into the books
 * is not something an unlocked machine on a desk should be able to mint; main re-checks
 * the passphrase against the vault, exactly as opening the company does.
 *
 * AND THE NEW SET IS SHOWN EXACTLY ONCE, through the same ../components/RecoverySheet.tsx
 * the create flow uses, with the same typed-code gate. Leaving the screen loses them,
 * which the screen says out loud rather than trying to prevent: a guard that stopped
 * navigation would be a new promise, and this is the wrong screen to be inventive on.
 */

import { useCallback, useState } from 'react'
import type { JSX } from 'react'
import { Button, Dialog } from '@renderer/components/atoms'
import { callApi } from '@renderer/lib/api'
import { registerScreens } from '@renderer/lib/screens'
import { useCompany } from '@renderer/store/company'
import { useToasts } from '@renderer/store/toasts'
import type { AppError, RecoveryCodesIssued } from '@shared/dto'
import { EmptyState } from '../components/EmptyState'
import { FailureNotice } from '../components/FailureNotice'
import { Notice } from '../components/Notice'
import { PassphraseField } from '../components/PassphraseField'
import { CLOSED_GATE, RecoverySheet } from '../components/RecoverySheet'
import type { RecoveryGateState } from '../components/RecoverySheet'
import { ScreenFrame } from '../components/ScreenFrame'
import { RECOVERY_CODE_SET_SIZE, recoveryView } from '../lib/recovery-view'

export function RecoveryCodes(): JSX.Element {
  const { company, recoveryCodesRemaining, recordRecoveryCodes } = useCompany()
  const { show } = useToasts()
  const [isAsking, setAsking] = useState(false)
  const [issued, setIssued] = useState<RecoveryCodesIssued | null>(null)
  const [gate, setGate] = useState<RecoveryGateState>(CLOSED_GATE)

  const onIssued = useCallback(
    (result: RecoveryCodesIssued) => {
      setAsking(false)
      setGate(CLOSED_GATE)
      setIssued(result)
      recordRecoveryCodes(result.recoveryCodesRemaining)
    },
    [recordRecoveryCodes],
  )

  /* The only way the codes leave this process: the state that holds them is dropped. */
  const putAway = useCallback(() => {
    setIssued(null)
    setGate(CLOSED_GATE)
    show({
      tone: 'success',
      title: 'New recovery codes are in force',
      body: 'Every code issued before today stopped working the moment these were made. If an old sheet is still lying about, it is now only paper.',
    })
  }, [show])

  /* The shell only draws this screen with a company open; the guard is for the type. */
  if (company === null) {
    return (
      <ScreenFrame isInset width="form" title="Recovery codes">
        <EmptyState title="No company is open" titleAs="h2">
          <p>Open a company to see its recovery codes.</p>
        </EmptyState>
      </ScreenFrame>
    )
  }

  if (issued !== null) {
    return (
      <ScreenFrame
        isInset
        width="form"
        title={`Write these ${RECOVERY_CODE_SET_SIZE} codes down now`}
        lede="Your old codes stopped working the moment these were made. These are the ones that open the books from now on."
      >
        <div className="stack">
          <Notice tone="danger" title="This is the only time these are shown">
            <p>
              Nothing can bring them back — not Coffer, not a backup, not this screen if you leave
              it. Save them before you go anywhere else.
            </p>
          </Notice>

          {/* Keyed on the set, so issuing twice in one session draws a fresh challenge
              rather than asking for the same position again. */}
          <RecoverySheet
            key={issued.recoveryCodes[0] ?? 'codes'}
            companyName={company.displayName}
            filePath={company.filePath}
            codes={issued.recoveryCodes}
            onGateChange={setGate}
          />

          <div className="actions print-hidden">
            <Button variant="primary" disabled={!gate.canContinue} onClick={putAway}>
              Put them away
            </Button>
            {!gate.canContinue && (
              <span className="prose prose--muted">
                Type code {gate.position} and tick the box first.
              </span>
            )}
          </div>
        </div>
      </ScreenFrame>
    )
  }

  const view = recoveryView(recoveryCodesRemaining)

  return (
    <ScreenFrame
      isInset
      width="form"
      title="Recovery codes"
      lede="One-time codes that open these books without the passphrase. Coffer keeps no copy of any of them — only a way to recognise one when it is typed."
      actions={
        <Button variant="primary" icon="lock" onClick={() => setAsking(true)}>
          Issue {RECOVERY_CODE_SET_SIZE} new codes
        </Button>
      }
    >
      <div className="stack">
        <section className="fact" aria-labelledby="codes-left">
          <span className="fact__label" id="codes-left">
            Codes left
          </span>
          <div className="codes">
            <div
              className="codes__bar"
              data-tone={view.tone}
              role="meter"
              aria-label="Unused recovery codes"
              aria-valuemin={0}
              aria-valuemax={view.issued}
              aria-valuenow={view.remaining}
              aria-valuetext={view.valueText}
            >
              {Array.from({ length: view.issued }, (_unused, index) => (
                <span
                  key={index}
                  className="codes__segment"
                  data-filled={index < view.remaining ? 'true' : 'false'}
                />
              ))}
            </div>
            <p className="codes__count">{view.valueText}</p>
          </div>
          <p className="prose">{view.line}</p>
        </section>

        <section className="stack stack--tight" aria-labelledby="what-a-code-does">
          <h2 className="caps-label" id="what-a-code-does">
            What a code does
          </h2>
          <p className="prose">
            Typing one at the picker opens {company.displayName} without the passphrase and makes
            you set a new one there and then. The code is spent in the same breath: it is recorded
            as used before the books open, so a code that worked once cannot work again.
          </p>
          <p className="prose">
            The rest of the sheet keeps working. Recovering does not issue a new set, because that
            would invalidate the four codes in your hand at the one moment you have proved you need
            them.
          </p>
        </section>

        <section className="stack stack--tight" aria-labelledby="issuing">
          <h2 className="caps-label" id="issuing">
            Issuing a new set
          </h2>
          <p className="prose">
            A new set replaces the old one completely.{' '}
            <strong>All {view.issued} codes you have now stop working</strong>, including the ones
            you have never used, and there is no way to bring one back. Do it when the sheet is
            lost, when somebody who should not have it might, or when you are down to the last one
            or two.
          </p>
          <p className="prose">
            Your passphrase does not change, the books are not re-encrypted, and this company stays
            open while it happens. Only the way in through a code is replaced.
          </p>
        </section>
      </div>

      {/* Keyed on open, so every opening starts with an empty field: a dialog that kept
          the last attempt's passphrase in memory after it closed would be holding it for
          nothing. */}
      <IssueDialog
        key={isAsking ? 'open' : 'closed'}
        isOpen={isAsking}
        onClose={() => setAsking(false)}
        onIssued={onIssued}
      />
    </ScreenFrame>
  )
}

interface IssueDialogProps {
  isOpen: boolean
  onClose: () => void
  onIssued: (result: RecoveryCodesIssued) => void
}

function IssueDialog({ isOpen, onClose, onIssued }: IssueDialogProps): JSX.Element {
  const [passphrase, setPassphrase] = useState('')
  const [isBusy, setBusy] = useState(false)
  const [error, setError] = useState<AppError | null>(null)

  const submit = useCallback(async () => {
    if (isBusy) return
    setBusy(true)
    setError(null)
    const result = await callApi((api) => api.companies.replaceRecoveryCodes({ passphrase }))
    setBusy(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    setPassphrase('')
    onIssued(result.data)
  }, [isBusy, passphrase, onIssued])

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      /* A plain boolean, never the text: nothing may hold a second copy of a passphrase.
       * See `useHasTyped`, which the other dialogs use and this one must not. */
      hasUnsavedInput={passphrase !== ''}
      title={`Issue ${RECOVERY_CODE_SET_SIZE} new recovery codes`}
      description="The codes you have now stop working, including the unused ones. The new set is shown once, on the next screen."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void submit()} isBusy={isBusy}>
            Issue {RECOVERY_CODE_SET_SIZE} new codes
          </Button>
        </>
      }
    >
      <div className="stack">
        {error && <FailureNotice error={error} context="new-recovery-codes" />}

        <PassphraseField
          label="Your passphrase"
          value={passphrase}
          onChange={setPassphrase}
          isDisabled={isBusy}
          onSubmit={() => void submit()}
          hint="Asked for again because this mints five new ways into the books. An open company is not proof of who is at the keyboard."
        />

        <Notice tone="warning" title="Have somewhere to write them down">
          <p>
            The new codes appear once and cannot be shown again. If you cannot save them now, cancel
            and come back when you can.
          </p>
        </Notice>
      </div>
    </Dialog>
  )
}

registerScreens([
  {
    id: 'recovery-codes',
    title: 'Recovery codes',
    area: 'workspace',
    nav: { label: 'Recovery codes', icon: 'lock', group: 'company', order: 3 },
    render: () => <RecoveryCodes />,
  },
])
