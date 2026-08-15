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
 *   3. The confirmation is not a checkbox. Coffer names one of the five codes and asks
 *      for it back. Somebody who can type code four has the sheet in front of them;
 *      somebody clicking through cannot produce it. The checkbox is still there, because
 *      the sentence it carries is worth reading, but the typed code is the gate.
 *   4. The screen says where to keep them: not on this machine. A recovery code in a text
 *      file beside the database it opens protects nothing — SECURITY.md says so, and this
 *      is where a user actually decides.
 */

import { useCallback, useState } from 'react'
import type { JSX } from 'react'
import { Button, Icon, Input } from '@renderer/components/atoms'
import { useAppInfo } from '@renderer/store/platform'
import { useCompany } from '@renderer/store/company'
import { useToasts } from '@renderer/store/toasts'
import type { OpenCompanyResult } from '@shared/dto'
import { CheckboxField } from '../components/CheckboxField'
import { Notice } from '../components/Notice'
import { ScreenFrame } from '../components/ScreenFrame'
import { copyText, offerTextDownload, printPage } from '../lib/browser'
import { challengeIndex, gateHint, gateState } from '../lib/recovery-gate'
import { codeRows, recoverySheetText, sheetDate, sheetFileName } from '../lib/recovery-sheet'

interface RecoveryCodesStepProps {
  result: OpenCompanyResult
}

export function RecoveryCodesStep({ result }: RecoveryCodesStepProps): JSX.Element {
  const { adopt } = useCompany()
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

  const sheet = recoverySheetText({
    companyName: company.displayName,
    filePath: company.filePath,
    codes,
    generatedAt,
    ...(appInfo === null ? {} : { appVersion: appInfo.version }),
  })

  const gate = gateState({ codes, challenge, typed, hasAcknowledged })

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
            <Button variant="primary" onClick={() => adopt(result)}>
              Open {company.displayName}
            </Button>
          </div>
        </div>
      </ScreenFrame>
    )
  }

  return (
    <ScreenFrame
      title="Save your recovery codes"
      lede={`${company.displayName} is created. These ${codes.length} codes are the only way back in if the passphrase is lost — and this is the only time they are shown.`}
    >
      <div className="stack">
        <Notice tone="danger" title="Coffer cannot show these again">
          <p>
            The vault stores a one-way check of each code, never the code itself. Nobody can print
            them a second time — not you, not Coffer, not the people who wrote it. Save them now,
            before you continue.
          </p>
        </Notice>

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
            {codeRows(codes).map((row, rowIndex) => (
              <li key={rowIndex} className="sheet__row">
                {row.map((code, columnIndex) => {
                  const position = rowIndex * 2 + columnIndex + 1
                  return (
                    <span key={code} className="sheet__code">
                      <span className="sheet__number">{position}</span>
                      <span className="sheet__value selectable">{code}</span>
                    </span>
                  )
                })}
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
            Copy
          </Button>
          <Button icon="archive" onClick={onSave}>
            Save to a file
          </Button>
          <Button icon="ledger" onClick={onPrint}>
            Print
          </Button>
        </div>

        <Notice tone="info" title="Keep them away from this computer" icon="info">
          <p>
            A code stored beside the file it protects protects nothing. Print the sheet and put it
            where you keep documents that matter, or save it to something you can unplug. If you
            keep it in a password manager, it must not be one whose only copy lives on this machine.
          </p>
        </Notice>

        <section className="confirm print-hidden">
          <h2 className="confirm__title">Confirm you have them</h2>
          <p className="confirm__body">
            Read code <strong>{challenge + 1}</strong> back from what you just saved. It is the
            difference between having these codes and believing you do.
          </p>

          <Input
            label={`Code ${challenge + 1}`}
            value={typed}
            className="confirm__input"
            placeholder="A1B2C-3D4E5-F6G7H-8J9K0"
            autoComplete="off"
            spellCheck={false}
            hint={gateHint(gate, challenge + 1)}
            onChange={(event) => setTyped(event.target.value)}
          />

          <CheckboxField isChecked={hasAcknowledged} onChange={setAcknowledged}>
            I have saved these codes somewhere other than this computer, and I understand that
            losing them and the passphrase means losing these books.
          </CheckboxField>

          <div className="actions">
            <Button
              variant="primary"
              iconEnd="arrow-right"
              disabled={!gate.canContinue}
              onClick={() => adopt(result)}
            >
              Open {company.displayName}
            </Button>
          </div>
        </section>
      </div>
    </ScreenFrame>
  )
}
