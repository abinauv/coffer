import { describe, expect, it } from 'vitest'
import {
  codeRows,
  recoverySheetText,
  remainingCodesNotice,
  sheetDate,
  sheetFileName,
} from './recovery-sheet'

const CODES = [
  'A1B2C-3D4E5-F6G7H-8J9K0',
  'ZYXWV-TSRQP-NMKJH-GFEDC',
  'M4NPQ-R5STV-W6XYZ-01234',
  'QRSTV-WXYZ0-12345-6789A',
  'HJKMN-PQRST-VWXYZ-01234',
]

const SHEET = {
  companyName: 'Acme Traders',
  filePath: 'D:\\books\\Acme-Traders.coffer',
  codes: CODES,
  generatedAt: new Date(2026, 7, 14, 15, 4),
  appVersion: '0.1.0',
}

describe('recoverySheetText', () => {
  it('carries every code, numbered', () => {
    const text = recoverySheetText(SHEET)
    for (const [index, code] of CODES.entries()) {
      expect(text).toContain(`${index + 1}.  ${code}`)
    }
  })

  it('names the company and the file the codes belong to', () => {
    const text = recoverySheetText(SHEET)
    expect(text).toContain('Acme Traders')
    expect(text).toContain('D:\\books\\Acme-Traders.coffer')
  })

  it('says where not to keep it', () => {
    expect(recoverySheetText(SHEET)).toContain('away from the computer holding the file')
  })

  it('says the codes cannot be shown again', () => {
    expect(recoverySheetText(SHEET)).toContain('cannot show these codes again')
  })

  it('explains that each code is single use', () => {
    expect(recoverySheetText(SHEET)).toContain('opens this company once')
  })

  it('omits the version line when the build is unknown', () => {
    const { appVersion: _unused, ...rest } = SHEET
    expect(recoverySheetText(rest)).not.toContain('Coffer:    ')
  })
})

describe('sheetFileName', () => {
  it('names the company, the product and the day', () => {
    expect(sheetFileName('Acme Traders', new Date(2026, 7, 14))).toBe(
      'coffer-recovery-codes-acme-traders-2026-08-14.txt',
    )
  })

  it('survives a company name full of path characters', () => {
    expect(sheetFileName('Acme / Traders (2026)', new Date(2026, 0, 2))).toBe(
      'coffer-recovery-codes-acme-traders-2026-2026-01-02.txt',
    )
  })

  it('still produces a file name when the company name reduces to nothing', () => {
    expect(sheetFileName('***', new Date(2026, 11, 31))).toBe(
      'coffer-recovery-codes-2026-12-31.txt',
    )
  })
})

describe('sheetDate', () => {
  it('pads to a sortable ISO day', () => {
    expect(sheetDate(new Date(2026, 0, 5))).toBe('2026-01-05')
  })
})

describe('codeRows', () => {
  it('lays five codes out in three rows of two', () => {
    const rows = codeRows(CODES)
    expect(rows).toHaveLength(3)
    expect(rows[2]).toHaveLength(1)
    expect(rows.flat()).toEqual(CODES)
  })
})

describe('remainingCodesNotice', () => {
  it('warns hard when the last code has been spent', () => {
    const notice = remainingCodesNotice(0)
    expect(notice.title).toContain('last recovery code')
    expect(notice.body).toContain('only way into this company')
  })

  it('counts down in the singular when one is left', () => {
    expect(remainingCodesNotice(1).title).toBe('One recovery code left')
  })

  it('says how many are left otherwise, and that the used one is gone', () => {
    const notice = remainingCodesNotice(4)
    expect(notice.title).toBe('4 recovery codes left')
    expect(notice.body).toContain('never work again')
  })
})
