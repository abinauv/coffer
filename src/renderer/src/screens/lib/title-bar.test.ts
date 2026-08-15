import { describe, expect, it } from 'vitest'
import {
  isSameOverlay,
  OVERLAY_BACKGROUND_TOKEN,
  OVERLAY_SYMBOL_TOKEN,
  overlayColorsFrom,
  toHexColor,
} from './title-bar'

function reader(tokens: Record<string, string>) {
  return (token: string): string => tokens[token] ?? ''
}

describe('toHexColor', () => {
  it('passes a six-digit hex through, trimmed and folded', () => {
    expect(toHexColor('  #ECEAE4 ')).toBe('#eceae4')
  })

  it('expands shorthand hex', () => {
    expect(toHexColor('#abc')).toBe('#aabbcc')
  })

  it('drops the alpha channel the OS overlay cannot use', () => {
    expect(toHexColor('#11151980')).toBe('#111519')
  })

  it('converts the rgb() form a browser may hand back', () => {
    expect(toHexColor('rgb(17, 21, 25)')).toBe('#111519')
    expect(toHexColor('rgba(17 21 25 / 0.8)')).toBe('#111519')
  })

  it('refuses anything it cannot be sure of', () => {
    expect(toHexColor('')).toBeNull()
    expect(toHexColor('chartreuse')).toBeNull()
    expect(toHexColor('#12345')).toBeNull()
    expect(toHexColor('rgb(300, 0, 0)')).toBeNull()
    expect(toHexColor('var(--chrome)')).toBeNull()
  })
})

describe('overlayColorsFrom', () => {
  it('reads the two title-bar tokens', () => {
    const colors = overlayColorsFrom(
      reader({ [OVERLAY_BACKGROUND_TOKEN]: '#111519', [OVERLAY_SYMBOL_TOKEN]: '#9aa4b2' }),
    )
    expect(colors).toEqual({ color: '#111519', symbolColor: '#9aa4b2' })
  })

  it('sends nothing rather than half a repaint', () => {
    expect(overlayColorsFrom(reader({ [OVERLAY_BACKGROUND_TOKEN]: '#111519' }))).toBeNull()
    expect(overlayColorsFrom(reader({}))).toBeNull()
  })
})

describe('isSameOverlay', () => {
  it('recognises the colours already sent', () => {
    const colors = { color: '#111519', symbolColor: '#9aa4b2' }
    expect(isSameOverlay(colors, { ...colors })).toBe(true)
    expect(isSameOverlay(colors, { ...colors, symbolColor: '#47505f' })).toBe(false)
  })

  it('treats "nothing sent yet" as different from any colour', () => {
    expect(isSameOverlay(null, { color: '#111519', symbolColor: '#9aa4b2' })).toBe(false)
    expect(isSameOverlay(null, null)).toBe(true)
  })
})
