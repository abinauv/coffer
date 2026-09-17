/*
 * The recovery codes themselves, wherever they are shown.
 *
 * Coffer shows a set of codes exactly twice in its life: once when a company is created,
 * and once more if the user deliberately issues a new set. Both are the same moment —
 * text on screen that exists nowhere else and cannot be produced again — so both draw
 * the same thing: the sheet, the three ways to save it, and the gate.
 *
 * THE GATE IS NOT A CHECKBOX (design plan, D1). Coffer names one of the codes and asks
 * for it back. Somebody who can type code four has the sheet in front of them; somebody
 * clicking through cannot produce it. The box is still there, because the sentence it
 * carries is worth reading, but the typed code is what opens the way out.
 *
 * The gate lives here rather than in the callers so that there is one copy of it, and it
 * is reported upwards because what a closed gate means differs: on the create flow it
 * holds the books shut, and on the Recovery codes screen it holds the codes on screen.
 * Give the component a `key` that changes with the codes and a fresh challenge is drawn.
 */

import { useCallback, useEffect, useState } from 'react'
import type { JSX } from 'react'
import { Button, Icon, Input } from '@renderer/components/atoms'
import { useAppInfo } from '@renderer/store/platform'
import { useToasts } from '@renderer/store/toasts'
import { copyText, offerTextDownload, printPage } from '../lib/browser'
import { countWord } from '../lib/create-flow'
import { challengeIndex, gateHint, gateState } from '../lib/recovery-gate'
import { writtenDayOf } from '@shared/written-date'
import { recoverySheetText, sheetFileName } from '../lib/recovery-sheet'
import { CheckboxField } from './CheckboxField'

/** What a caller needs to know about the gate: whether it is open, and what is missing. */
export interface RecoveryGateState {
  canContinue: boolean
  /** Which code was asked for, counting from one. For a caller's own hint. */
  position: number
  /** The sentence under the field. Already shown here; callers may echo a short form. */
  hint: string
}

/** A gate that is shut, for a caller's initial state. */
export const CLOSED_GATE: RecoveryGateState = {
  canContinue: false,
  position: 1,
  hint: '',
}

interface RecoverySheetProps {
  companyName: string
  /** The database file these codes open. Names which books, without being a secret. */
  filePath: string
  codes: readonly string[]
  /** Told whenever the gate opens or closes. A `useState` setter is the usual argument. */
  onGateChange: (gate: RecoveryGateState) => void
}

export function RecoverySheet({
  companyName,
  filePath,
  codes,
  onGateChange,
}: RecoverySheetProps): JSX.Element {
  const { show } = useToasts()
  const appInfo = useAppInfo()

  const [generatedAt] = useState(() => new Date())
  /* Chosen once, when the sheet appears: a challenge that changed as you typed would be
   * a puzzle rather than a check. */
  const [challenge] = useState(() => challengeIndex(codes.length, Math.random()))
  const [typed, setTyped] = useState('')
  const [hasAcknowledged, setAcknowledged] = useState(false)

  const sheet = recoverySheetText({
    companyName,
    filePath,
    codes,
    generatedAt,
    ...(appInfo === null ? {} : { appVersion: appInfo.version }),
  })

  const gate = gateState({ codes, challenge, typed, hasAcknowledged })
  const hint = gateHint(gate, challenge + 1)
  const count = countWord(codes.length)

  useEffect(() => {
    onGateChange({ canContinue: gate.canContinue, position: challenge + 1, hint })
  }, [onGateChange, gate.canContinue, challenge, hint])

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
    const fileName = sheetFileName(companyName, generatedAt)
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
  }, [companyName, generatedAt, sheet, show])

  const onPrint = useCallback(() => {
    if (printPage()) return
    show({
      tone: 'danger',
      title: 'Coffer could not open the print dialog',
      body: 'Copy the codes or save them to a file instead.',
      dedupeKey: 'recovery-print',
    })
  }, [show])

  return (
    <div className="stack">
      {/* The sheet. The print stylesheet hides everything else on the page and prints
          exactly this block. */}
      <section className="sheet" aria-label="Recovery codes">
        <header className="sheet__head">
          <Icon name="lock" size={16} className="sheet__mark" />
          <div className="sheet__titles">
            <h2 className="sheet__title">Coffer recovery codes</h2>
            <p className="sheet__subject selectable">
              {companyName} · {filePath}
            </p>
          </div>
          <p className="sheet__date">{writtenDayOf(generatedAt)}</p>
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
          Each code opens {companyName} once, without the passphrase, and sets a new one. Using a
          code spends it; the rest keep working.
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
          hint={hint}
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
  )
}
