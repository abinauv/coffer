/*
 * The recovery codes. Shown once, and then never again by anyone.
 *
 * This is the highest-stakes screen in Coffer. Everything before it can be repeated;
 * nothing after it can bring these codes back. `OpenCompanyResult.recoveryCodes` arrives
 * exactly once — at creation — and the vault keeps only a one-way verifier of each code,
 * so there is no path from anything on disk back to the text below.
 *
 * THE SHEET, THE THREE WAYS TO SAVE IT AND THE TYPED-CODE GATE are ../components/
 * RecoverySheet.tsx, because Company → Recovery codes shows the same thing when a user
 * deliberately issues a new set. What belongs to this step is the frame around them.
 *
 * TWO DECISIONS, EACH DELIBERATE.
 *
 *   1. There is no way past this screen except through it. No Back, no Skip, no Escape.
 *      The company is already open in main, but the shell does not switch to the
 *      workspace until this screen hands the result over — so "later" is not on offer,
 *      because there is no later.
 *   2. The screen says where to keep them: not on this machine. A recovery code in a text
 *      file beside the database it opens protects nothing — SECURITY.md says so, and this
 *      is where a user actually decides.
 *
 * AND ONE THING IT DOES ON THE WAY OUT. A registration number typed on the first step is
 * saved into Business details as the books open. It never holds the door: a save that
 * fails says so in a toast that stays until it is dismissed, and the books open anyway.
 */

import { useCallback, useState } from 'react'
import type { JSX } from 'react'
import { Button, Icon } from '@renderer/components/atoms'
import { callApi } from '@renderer/lib/api'
import { makeRoute } from '@renderer/lib/routing'
import { useCompany } from '@renderer/store/company'
import { useNavigation } from '@renderer/store/navigation'
import { useToasts } from '@renderer/store/toasts'
import type { OpenCompanyResult } from '@shared/dto'
import { Notice } from '../components/Notice'
import { CLOSED_GATE, RecoverySheet } from '../components/RecoverySheet'
import type { RecoveryGateState } from '../components/RecoverySheet'
import { ScreenFrame } from '../components/ScreenFrame'
import { StepCard, StepFrame } from '../components/StepFrame'
import { CREATE_STEPS, countWord } from '../lib/create-flow'

interface RecoveryCodesStepProps {
  result: OpenCompanyResult
  /** A registration number checked on the first step, to save as the books open. */
  registrationNumber?: string | null
}

export function RecoveryCodesStep({
  result,
  registrationNumber = null,
}: RecoveryCodesStepProps): JSX.Element {
  const { adopt } = useCompany()
  const { navigate } = useNavigation()
  const { show } = useToasts()

  const company = result.company
  const codes = result.recoveryCodes ?? []
  const [gate, setGate] = useState<RecoveryGateState>(CLOSED_GATE)
  const [isOpening, setOpening] = useState(false)

  const count = countWord(codes.length)

  const openBooks = useCallback(async () => {
    if (isOpening) return
    setOpening(true)
    if (registrationNumber !== null) {
      const isSaved = await saveRegistration(company.displayName, registrationNumber)
      if (!isSaved) {
        show({
          tone: 'warning',
          title: 'The registration number was not saved',
          body: `${company.displayName} is created and open, but ${registrationNumber} did not reach Business details. Enter it there; nothing else is affected.`,
          durationMs: null,
          action: {
            label: 'Business details',
            run: () => navigate(makeRoute('workspace', 'company-profile')),
          },
        })
      }
    }
    adopt(result)
  }, [isOpening, registrationNumber, company.displayName, show, navigate, adopt, result])

  /* No codes should be impossible here, but a screen that silently shows an empty box is
   * worse than one that says what happened. */
  if (codes.length === 0) {
    return (
      <ScreenFrame title="No recovery codes were issued">
        <div className="stack">
          <Notice tone="warning" title="This company has no recovery codes to show">
            <p>
              {company.displayName} is created and open, but Coffer did not receive a set of
              recovery codes for it. That means the passphrase is currently the only way in. Take a
              backup as soon as it opens, and keep it somewhere safe.
            </p>
          </Notice>
          <div className="actions">
            <Button variant="primary" onClick={() => void openBooks()} isBusy={isOpening}>
              Open {company.displayName}
            </Button>
          </div>
        </div>
      </ScreenFrame>
    )
  }

  return (
    <StepFrame
      flowLabel="Creating a company"
      steps={CREATE_STEPS}
      current={2}
      status={
        <p className="step-frame__done">
          <Icon name="check-circle" size={15} />
          <span>
            {company.displayName} created at <span className="selectable">{company.filePath}</span>
          </span>
        </p>
      }
      title={`Write these ${count} codes down now`}
      lede={
        <>
          Any one of them opens the books once if the passphrase is ever lost, and makes you set a
          new one on the spot. <strong>This screen is shown exactly once.</strong> There is no way
          back to it, and no copy is kept anywhere.
        </>
      }
      aside={
        <>
          <StepCard title="Where to keep them">
            <p>
              A page at the back of the ledger. The office safe. A sealed envelope with your
              accountant. Anywhere that is not the same machine as the books.
            </p>
          </StepCard>
          <StepCard title="No Back, no Skip, no Escape" tone="danger">
            <p>
              The company already exists. Every way out of this screen except forward has been
              removed on purpose: a way out of here is a way to lose your books.
            </p>
          </StepCard>
        </>
      }
      hint={gate.canContinue ? null : `Type code ${gate.position} and tick the box first`}
      primary={
        <Button
          variant="primary"
          iconEnd="arrow-right"
          disabled={!gate.canContinue}
          isBusy={isOpening}
          onClick={() => void openBooks()}
        >
          Open the books
        </Button>
      }
    >
      <RecoverySheet
        companyName={company.displayName}
        filePath={company.filePath}
        codes={codes}
        onGateChange={setGate}
      />
    </StepFrame>
  )
}

/**
 * The registration number from the first step, into Business details.
 *
 * The business name is the legal name: the first step asks for it "as it should appear on
 * your invoices". The country is the regime's id where that is a country code — the rule
 * Business details seeds its own blank form with — and main fills the jurisdiction in from
 * the number. Answers whether it worked; the caller says so when it did not.
 */
async function saveRegistration(legalName: string, registrationNumber: string): Promise<boolean> {
  const regime = await callApi((api) => api.regime.describe())
  if (!regime.ok || regime.data.id.length !== 2) return false
  const saved = await callApi((api) =>
    api.companyProfile.save({ legalName, countryCode: regime.data.id, registrationNumber }),
  )
  return saved.ok
}
