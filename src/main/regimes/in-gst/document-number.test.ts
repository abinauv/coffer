import { describe, expect, it } from 'vitest'
import { MAX_DOCUMENT_NUMBER_LENGTH, validateDocumentNumber } from './document-number'

describe('what rule 46(b) allows', () => {
  it('accepts the shape the default series produces', () => {
    expect(validateDocumentNumber('INV/2026-27/0001').isValid).toBe(true)
  })

  it('accepts digits alone, letters alone, and the two punctuation marks', () => {
    for (const value of ['1', 'A', '0001', 'SI-0042', '2026/0001', 'A-B/C-D']) {
      expect(validateDocumentNumber(value).isValid).toBe(true)
    }
  })

  it('accepts a number of exactly sixteen characters', () => {
    const sixteen = 'INV/2026-27/0001'
    expect(sixteen).toHaveLength(MAX_DOCUMENT_NUMBER_LENGTH)
    expect(validateDocumentNumber(sixteen).isValid).toBe(true)
  })
})

describe('what it refuses', () => {
  it('refuses a seventeenth character', () => {
    /* The boundary is where this rule is actually broken: a series with one character
     * more than it needs uploads perfectly until the sequence reaches five digits. */
    const seventeen = 'INV/2026-27/00001'
    expect(seventeen).toHaveLength(MAX_DOCUMENT_NUMBER_LENGTH + 1)

    const result = validateDocumentNumber(seventeen)
    expect(result.isValid).toBe(false)
    expect(result.message).toContain('16')
    expect(result.message).toContain('17')
  })

  it('refuses an empty number', () => {
    expect(validateDocumentNumber('').isValid).toBe(false)
  })

  it('refuses the punctuation people reach for anyway', () => {
    /* A space and a full stop are the two that turn up in imported data, and '#' is what
     * somebody types when they mean "number". None of the three is allowed. */
    for (const value of ['INV 0001', 'INV.0001', 'INV#0001', 'INV_0001', 'INV\\0001']) {
      expect(validateDocumentNumber(value).isValid).toBe(false)
    }
  })

  it('says what is wrong rather than that something is', () => {
    expect(validateDocumentNumber('INV 0001').message).toContain('letters, digits')
    expect(validateDocumentNumber('').message).toContain('required')
  })
})

describe('what it deliberately does not check', () => {
  it('says nothing about uniqueness, which no string can answer', () => {
    /* Rule 46(b)'s fourth requirement — unique for a financial year — belongs to the
     * numbering counter and the index behind it. Answering `true` twice for the same
     * number here is correct, and a check that pretended otherwise would be a lie the
     * repository would then have to make true anyway. */
    expect(validateDocumentNumber('INV/2026-27/0001').isValid).toBe(true)
    expect(validateDocumentNumber('INV/2026-27/0001').isValid).toBe(true)
  })

  /* Unlike a GSTIN, a document number has no canonical spelling to impose: it is a label
   * the business chose, and `inv/2026-27/0001` is what somebody meant to write. */
  it('keeps a valid number exactly as it was written', () => {
    expect(validateDocumentNumber('inv/2026-27/0001').normalisedValue).toBe('inv/2026-27/0001')
    expect(validateDocumentNumber('').normalisedValue).toBeNull()
    expect(validateDocumentNumber('INV 0001').normalisedValue).toBeNull()
  })

  it('derives no jurisdiction, unlike a GSTIN', () => {
    expect(validateDocumentNumber('INV/2026-27/0001').derivedJurisdictionCode).toBeNull()
  })
})
