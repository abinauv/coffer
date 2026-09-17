/*
 * The recovery sheet, as text.
 *
 * The same words go to the clipboard and into the saved file, because a user comparing
 * the two should not have to wonder whether they got the same thing. What the sheet says
 * matters as much as the codes on it: found in a drawer in three years, it has to explain
 * itself to somebody who has forgotten this screen entirely.
 *
 * It names the company and the file the codes belong to. It does not contain, and must
 * never contain, the passphrase.
 */

/** How the saved file is named. Kept simple enough to type into a search box. */
import { writtenDayOf } from '@shared/written-date'

export const SHEET_FILE_PREFIX = 'coffer-recovery-codes'

export interface SheetInput {
  companyName: string
  /** The database file these codes open. Names which books, without being a secret. */
  filePath: string
  codes: readonly string[]
  /** When the codes were issued. */
  generatedAt: Date
  /** The build that issued them, when known. */
  appVersion?: string
}

/** ISO date, no time, for the file name: it sorts, and a file name is not a sentence. */
export function sheetDate(date: Date): string {
  const year = date.getFullYear()
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * A file name that survives a download folder: product, company, date.
 *
 * The company name is reduced to letters, digits and hyphens — it is free text, and a
 * user may well have called their company `Acme / Traders (2026)`.
 */
export function sheetFileName(companyName: string, generatedAt: Date): string {
  const slug = companyName
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '')
  const middle = slug === '' ? '' : `-${slug}`
  return `${SHEET_FILE_PREFIX}${middle}-${sheetDate(generatedAt)}.txt`
}

/**
 * The sheet.
 *
 * Codes are numbered so that "code 3" means something when Coffer asks for one back, and
 * so a user reading a printout can tick them off as they are spent.
 */
export function recoverySheetText(input: SheetInput): string {
  const lines: string[] = [
    'Coffer — recovery codes',
    `Company:   ${input.companyName}`,
    `File:      ${input.filePath}`,
    `Issued:    ${writtenDayOf(input.generatedAt)}`,
  ]
  if (input.appVersion !== undefined && input.appVersion !== '') {
    lines.push(`Coffer:    ${input.appVersion}`)
  }

  lines.push('', ...input.codes.map((code, index) => `  ${index + 1}.  ${code}`), '')
  lines.push(
    'Each code opens this company once, without the passphrase, and sets a new one.',
    'Using a code spends it; the others keep working.',
    '',
    'Keep this sheet away from the computer holding the file above. A code stored',
    'beside the books it protects protects nothing.',
    '',
    'Coffer cannot show these codes again. A fresh set can be issued from inside the',
    'company, under Company → Recovery codes, but that needs the passphrase and it',
    'kills every code on this sheet. If these and the passphrase are both lost, this',
    'company cannot be opened by anyone.',
  )

  return `${lines.join('\n')}\n`
}

/** What to say about the codes that are left, after one has been spent. */
export function remainingCodesNotice(remaining: number): { title: string; body: string } {
  if (remaining <= 0) {
    return {
      title: 'That was your last recovery code',
      body:
        'Your passphrase is now the only way into this company. Issue a new set from ' +
        'Company → Recovery codes while you still have it — that screen needs the ' +
        'passphrase, so it is no help at all once the passphrase is gone.',
    }
  }
  if (remaining === 1) {
    return {
      title: 'One recovery code left',
      body:
        'One unused code remains on your sheet. Company → Recovery codes will issue a ' +
        'fresh set of five, which kills that last one along with the spent ones.',
    }
  }
  return {
    title: `${remaining} recovery codes left`,
    body:
      'The code you just used is spent and will never work again. Cross it off the sheet ' +
      'so you do not reach for it next time.',
  }
}
