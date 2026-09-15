/*
 * The recovery codes. Shown once, and then never again by anyone.
 *
 * This is the highest-stakes screen in Coffer. Everything before it can be repeated;
 * nothing after it can bring these codes back. `OpenCompanyResult.recoveryCodes` arrives
 * exactly once — at creation — and the vault keeps only a one-way verifier of each code,
 * so there is no path from anything on disk back to the text below.
 *
 * FOUR DECISIONS, EACH DELIBERATE.
 *
 *   1. There is no way past this screen except through it. No Back, no Skip, no Escape.
 *      The company is already open in main, but the shell does not switch to the
 *      workspace until this screen hands the result over — so "later" is not on offer,
 *      because there is no later.
 *   2. Saving is made easy three ways: copy, save to a file, print. A screen that says
 *      "write these down" and offers no way to do it is a screen that gets ignored.
 *   3. The confirmation is not a checkbox (design plan, D1). Coffer names one of the codes
 *      and asks for it back. Somebody who can type code four has the sheet in front of
 *      them; somebody clicking through cannot produce it. The checkbox is still there,
 *      because the sentence it carries is worth reading, but the typed code is the gate.
 *   4. The screen says where to keep them: not on this machine. A recovery code in a text
 *      file beside the database it opens protects nothing — SECURITY.md says so, and this
 *      is where a user actually decides.
 *
 * AND ONE THING IT DOES ON THE WAY OUT. A registration number typed on the first step is
 * saved into Business details as the books open. It never holds the door: a save that
 * fails says so in a toast that stays until it is dismissed, and the books open anyway.
 */

import { useCallback, useState } from 'react'
import type { JSX } from 'react'
import { Button, Icon, Input } from '@renderer/components/atoms'
import { callApi } from '@renderer/lib/api'
import { makeRoute } from '@renderer/lib/routing'
import { useAppInfo } from '@renderer/store/platform'
import { useCompany } from '@renderer/store/company'
import { useNavigation } from '@renderer/store/navigation'
import { useToasts } from '@renderer/store/toasts'
import type { OpenCompanyResult } from '@shared/dto'
import { CheckboxField } from '../components/CheckboxField'
import { Notice } from '../components/Notice'
import { ScreenFrame } from '../components/ScreenFrame'
import { StepCard, StepFrame } from '../components/StepFrame'
import { copyText, offerTextDownload, printPage } from '../lib/browser'
import { CREATE_STEPS, countWord } from '../lib/create-flow'
import { challengeIndex, gateHint, gateState } from '../lib/recovery-gate'
import { recoverySheetText, sheetDate, sheetFileName } from '../lib/recovery-sheet'

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
  const appInfo = useAppInfo()

  const company = result.company
  const codes = result.recoveryCodes ?? []
  const [generatedAt] = useState(() => new Date())
  /* Chosen once, when the screen appears: a challenge that changed as you typed would be
   * a puzzle rather than a check. */
  const [challenge] = useState(() => challengeIndex(codes.length, Math.random()))
  const [typed, setTyped] = useState('')
  const [hasAcknowledged, setAcknowledged] = useState(false)
  const [isOpening, setOpening] = useState(false)

  const sheet = recoverySheetText({
    companyName: company.displayName,
    filePath: company.filePath,
    codes,
    generatedAt,
    ...(appInfo === null ? {} : { appVersion: appInfo.version }),
  })

  const gate = gateState({ codes, challenge, typed, hasAcknowledged })
  const count = countWord(codes.length)

  const onCopy = useCallback(async () => {
    const copied = await copyText(sheet)
    show(
      copied
        ? {
            tone: 'success',
            title: 'Recovery sheet copied',
            body: 'Paste it somewhere off this machine. The clipboard keeps it until you copy something else.',
            dedupeKey: 'recovery-copy',
          }
        : {
            tone: 'danger',
            title: 'Coffer could not reach the clipboard',
            body: 'Select the codes on screen and copy them by hand, or use Print.',
            dedupeKey: 'recovery-copy',
          },
    )
  }, [sheet, show])

  const onSave = useCallback(() => {
    const fileName = sheetFileName(company.displayName, generatedAt)
    const offered = offerTextDownload(fileName, sheet)
    show(
      offered
        ? {
            tone: 'info',
            title: `Saving ${fileName}`,
            body: 'Choose somewhere away from this computer — a USB stick, or a phone you back up. If no save window appeared, copy or print the sheet instead.',
            dedupeKey: 'recovery-save',
          }
        : {
            tone: 'danger',
            title: 'Coffer could not offer the file',
            body: 'Copy the codes instead, or print this sheet.',
            dedupeKey: 'recovery-save',
          },
    )
  }, [company.displayName, generatedAt, sheet, show])

  const onPrint = useCallback(() => {
    if (printPage()) return
    show({
      tone: 'danger',
      title: 'Coffer could not open the print dialog',
      body: 'Copy the codes or save them to a file instead.',
      dedupeKey: 'recovery-print',
    })
  }, [show])

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
      hint={gate.canContinue ? null : `Type code ${challenge + 1} and tick the box first`}
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
      <div className="stack">
        {/* The sheet. The print stylesheet hides everything else on the page and prints
            exactly this block. */}
        <section className="sheet" aria-label="Recovery codes">
          <header className="sheet__head">
            <Icon name="lock" size={16} className="sheet__mark" />
            <div className="sheet__titles">
              <h2 className="sheet__title">Coffer recovery codes</h2>
              <p className="sheet__subject selectable">
                {company.displayName} · {company.filePath}
              </p>
            </div>
            <p className="sheet__date">{sheetDate(generatedAt)}</p>
          </header>

          <ol className="sheet__codes">
            {codes.map((code, index) => (
              <li key={code} className="sheet__code">
                <span className="sheet__number">{index + 1}</span>
                <span className="sheet__value selectable">{code}</span>
              </li>
            ))}
          </ol>

          <p className="sheet__foot">
            Each code opens {company.displayName} once, without the passphrase, and sets a new one.
            Using a code spends it; the rest keep working.
          </p>
        </section>

        <div className="actions print-hidden">
          <Button icon="check" onClick={() => void onCopy()}>
            Copy all {count}
          </Button>
          <Button icon="archive" onClick={onSave}>
            Save as a text file
          </Button>
          <Button icon="invoice" onClick={onPrint}>
            Print
          </Button>
        </div>

        <section className="confirm print-hidden" aria-labelledby="confirm-title">
          <h2 className="confirm__title" id="confirm-title">
            Confirm you have them
          </h2>
          <p className="confirm__body">
            Read code <strong>{challenge + 1}</strong> back from what you just saved. It is the
            difference between having these codes and believing you do.
          </p>

          <Input
            label={`Code ${challenge + 1}`}
            value={typed}
            /* Mono on the input alone. As `className` it landed on the field's wrapper and
             * set the label and hint in mono too (B10). */
            isIdentifier
            placeholder="A1B2C-3D4E5-F6G7H-8J9K0"
            autoComplete="off"
            spellCheck={false}
            hint={gateHint(gate, challenge + 1)}
            onChange={(event) => setTyped(event.target.value)}
          />

          <div className="confirm__box" data-checked={hasAcknowledged ? 'true' : 'false'}>
            <CheckboxField isChecked={hasAcknowledged} onChange={setAcknowledged}>
              I have written these {count} codes down somewhere that is not this computer, and I
              understand that losing them and the passphrase means losing these books.
            </CheckboxField>
          </div>
        </section>
      </div>
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
