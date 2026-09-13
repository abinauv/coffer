/*
 * The keycap.
 *
 * `shortcutParts` is covered as a pure function in lib/keys.test.ts. What is covered
 * only here is the rendering around it: one `<kbd>` per part, IN ORDER, and the platform
 * taken from the provider rather than guessed.
 *
 * ORDER IS THE POINT. macOS and Windows do not merely spell the modifiers differently,
 * they order them differently — Ctrl-Alt-Shift-Cmd against Ctrl-Alt-Shift — so the
 * fixture below carries three modifiers at once and the two platforms produce two
 * different sequences. A single-modifier shortcut would pass against a component that
 * sorted the parts, reversed them, or joined them into one cap.
 */

import { screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { AppInfo, Platform } from '@shared/dto'
import { DEFAULT_APP_INFO, renderScreen, type BridgeStub } from '@renderer/test/harness'
import { Kbd } from './Kbd'

function on(platform: Platform): BridgeStub {
  const info: AppInfo = { ...DEFAULT_APP_INFO, platform }
  return { system: { getAppInfo: () => Promise.resolve({ ok: true, data: info }) } }
}

/** The caps as they read left to right. */
function caps(): string[] {
  return [...document.querySelectorAll('kbd')].map((cap) => cap.textContent ?? '')
}

/* Three modifiers, so the two platforms disagree about the order as well as the
 * spelling. Alt is second on Windows and first on macOS. */
const EVERYTHING = { key: 'p', ctrlOrCmd: true, shift: true, alt: true } as const

describe('platform notation', () => {
  it('writes the modifiers out, in Windows order, off macOS', async () => {
    renderScreen(<Kbd shortcut={EVERYTHING} />, { bridge: on('win32') })

    await waitFor(() => expect(caps()).toEqual(['Ctrl', 'Alt', 'Shift', 'P']))
  })

  it('uses the symbols, in macOS order, on macOS', async () => {
    renderScreen(<Kbd shortcut={EVERYTHING} />, { bridge: on('darwin') })

    await waitFor(() => expect(caps()).toEqual(['⌥', '⇧', '⌘', 'P']))
  })

  it('reads the platform from the provider rather than the shortcut', async () => {
    const shortcut = { key: 'k', ctrlOrCmd: true } as const
    renderScreen(<Kbd shortcut={shortcut} />, { bridge: on('darwin') })

    await waitFor(() => expect(caps()).toEqual(['⌘', 'K']))
  })
})

describe('the caps themselves', () => {
  it('gives every part its own cap', async () => {
    renderScreen(<Kbd shortcut={EVERYTHING} />, { bridge: on('linux') })

    await waitFor(() => expect(caps()).toHaveLength(4))
    for (const cap of document.querySelectorAll('kbd')) {
      expect(cap).toHaveClass('kbd__key')
    }
  })

  it('is a single cap for an unmodified key', async () => {
    renderScreen(<Kbd shortcut={{ key: 'Enter' }} />, { bridge: on('linux') })

    await waitFor(() => expect(caps()).toEqual(['↵']))
  })

  it.each([
    ['ArrowUp', '↑'],
    ['ArrowDown', '↓'],
    ['Escape', 'Esc'],
    ['a', 'A'],
  ])('draws %s as %s', async (key, cap) => {
    renderScreen(<Kbd shortcut={{ key }} />, { bridge: on('linux') })

    await waitFor(() => expect(caps()).toEqual([cap]))
  })

  it('carries an extra class beside its own', async () => {
    const { container } = renderScreen(
      <Kbd shortcut={{ key: 'Enter' }} className="palette__cap" />,
      {
        bridge: on('linux'),
      },
    )

    await waitFor(() => expect(screen.getAllByText('↵')).toHaveLength(1))
    expect(container.querySelector('.kbd')).toHaveClass('kbd', 'palette__cap')
  })
})
