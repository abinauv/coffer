/*
 * The status bar.
 *
 * B15 in the design plan is the reason for most of this file: the sidebar it replaced cut
 * the company file's path down with an ellipsis, and the part it cut was the folder. The
 * whole path has to be in the text, not in a tooltip, and nothing may be styled to clip it.
 */

import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { CompanySummary } from '@shared/dto'
import { DEFAULT_COMPANY, renderScreen } from '@renderer/test/harness'
import { StatusBar } from './StatusBar'

const LONG_PATH =
  'C:\\Users\\Accounts\\Documents\\Coffer\\Clients 2026-27\\Sharma-Traders-Private-Limited.coffer'

const SHARMA: CompanySummary = { ...DEFAULT_COMPANY, filePath: LONG_PATH }

describe('the status bar', () => {
  it('prints the whole path of the open file, unclipped', () => {
    renderScreen(<StatusBar />, { company: SHARMA })

    const path = screen.getByText(LONG_PATH)
    expect(path).toBeVisible()
    expect(path).not.toHaveClass('truncate')
    expect(path.closest('.truncate')).toBeNull()
  })

  it('says what the path is to someone who cannot see where it sits', () => {
    renderScreen(<StatusBar />, { company: SHARMA })

    expect(screen.getByRole('contentinfo')).toHaveTextContent(`Company file: ${LONG_PATH}`)
  })

  it('states the encryption and that nothing connects', () => {
    renderScreen(<StatusBar />, { company: SHARMA })

    expect(screen.getByText('encrypted · SQLCipher')).toBeVisible()
    expect(screen.getByText('offline — this app never connects')).toBeVisible()
  })

  it('draws nothing while no company is open', () => {
    renderScreen(<StatusBar />, { company: null })

    expect(screen.queryByRole('contentinfo')).toBeNull()
  })
})
