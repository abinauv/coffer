import { describe, expect, it } from 'vitest'

import { BYTE_ORDER_MARK, foldText, isBlank, normaliseHeading, stripByteOrderMark } from './text'

describe('stripByteOrderMark', () => {
  it('removes one at position zero and reports it', () => {
    expect(stripByteOrderMark(`${BYTE_ORDER_MARK}Date`)).toEqual({
      text: 'Date',
      hadByteOrderMark: true,
    })
  })

  it('leaves text with no mark exactly as it was', () => {
    expect(stripByteOrderMark('Date')).toEqual({ text: 'Date', hadByteOrderMark: false })
  })

  it('removes only ONE, so a doubled mark still reports the second as content', () => {
    const twice = stripByteOrderMark(`${BYTE_ORDER_MARK}${BYTE_ORDER_MARK}Date`)
    expect(twice.hadByteOrderMark).toBe(true)
    expect(twice.text).toBe(`${BYTE_ORDER_MARK}Date`)
  })

  it('leaves a mark that is not at position zero, because there it is content', () => {
    expect(stripByteOrderMark(`Da${BYTE_ORDER_MARK}te`)).toEqual({
      text: `Da${BYTE_ORDER_MARK}te`,
      hadByteOrderMark: false,
    })
  })
})

describe('foldText', () => {
  it('collapses runs of whitespace to one space and trims the ends', () => {
    expect(foldText('  UPI   RAVI \t KUMAR  ')).toBe('UPI RAVI KUMAR')
  })

  it('folds a non-breaking space, which looks identical and is not', () => {
    const nonBreaking: string = '₹ 500'
    const plain: string = '₹ 500'
    expect(foldText(nonBreaking)).toBe(plain)
    /* The condition this alone excludes: without the fold these two are different
     * strings and a heading match fails for no visible reason. */
    expect(nonBreaking === plain).toBe(false)
  })

  it('removes zero-width characters rather than turning them into spaces', () => {
    /* U+200B is NOT in JavaScript's `\s`, so a whitespace fold alone leaves it in place.
     * Probed, not assumed. */
    expect(/\s/.test('​')).toBe(false)
    expect(foldText('Va​lue Date')).toBe('Value Date')
    expect(foldText('Va­lue')).toBe('Value')
  })

  it('removes a U+FEFF instead of leaving a space where it was', () => {
    /* U+FEFF IS in `\s`, so folding whitespace first would leave `Va lue`. */
    expect(/\s/.test(BYTE_ORDER_MARK)).toBe(true)
    expect(foldText(`Va${BYTE_ORDER_MARK}lue`)).toBe('Value')
  })

  it('normalises to NFC, so a combining accent equals its precomposed form', () => {
    const decomposed: string = 'Bengal\u0075\u0301ru'
    const composed: string = 'Bengal\u00faru'
    expect(decomposed === composed).toBe(false)
    expect(foldText(decomposed)).toBe(foldText(composed))
  })

  it('keeps case, because an amount parser must not lower-case and a narration is displayed', () => {
    expect(foldText('ACME Supplies')).toBe('ACME Supplies')
  })

  it('folds a newline the same as a space, so a wrapped heading still matches', () => {
    expect(foldText('Value\nDate')).toBe('Value Date')
  })
})

describe('normaliseHeading', () => {
  it('makes three spellings of one heading into one key', () => {
    expect(normaliseHeading('Value Date')).toBe('value date')
    expect(normaliseHeading('value date')).toBe('value date')
    expect(normaliseHeading(' VALUE DATE ')).toBe('value date')
    expect(normaliseHeading('Value  Date')).toBe('value date')
  })

  it('leaves an empty heading empty rather than inventing a name for it', () => {
    expect(normaliseHeading('   ')).toBe('')
  })
})

describe('isBlank', () => {
  it('is true for nothing, whitespace and invisibles alike', () => {
    for (const text of ['', ' ', '\t', '\n', ' ', '​', BYTE_ORDER_MARK]) {
      expect(isBlank(text), JSON.stringify(text)).toBe(true)
    }
  })

  it('is false for a zero, which is a value', () => {
    expect(isBlank('0')).toBe(false)
    expect(isBlank('0.00')).toBe(false)
  })
})
