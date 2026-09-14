/*
 * The one backup flow.
 *
 * What this file holds the provider to is the reason it exists: the rail, the Overview and
 * the palette start the SAME flow, so a second start while one is writing does nothing, and
 * every control that reads the busy state sees it. The flow's wording and its failures are
 * asserted where a user meets them, in Overview.test.tsx.
 */

import { act, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { JSX } from 'react'
import { describe, expect, it } from 'vitest'
import type { Result } from '@shared/dto'
import { DEFAULT_COMPANY, renderScreen } from '@renderer/test/harness'
import { useBackup } from './backup'
import { useCommands } from './commands'

function Controls(): JSX.Element {
  const { backUp, isBackingUp } = useBackup()
  const { commands } = useCommands()
  const command = commands.find((candidate) => candidate.id === 'company.backup')
  return (
    <>
      <button type="button" onClick={() => void backUp()}>
        first
      </button>
      <button type="button" onClick={() => void backUp()}>
        second
      </button>
      <p>busy: {isBackingUp ? 'yes' : 'no'}</p>
      <p>command: {command === undefined ? 'absent' : command.isDisabled ? 'disabled' : 'ready'}</p>
    </>
  )
}

describe('the backup flow', () => {
  it('starts once however many controls ask while it is running', async () => {
    const user = userEvent.setup()
    let asked = 0
    let answer: (value: Result<string | null>) => void = () => {}
    renderScreen(<Controls />, {
      company: DEFAULT_COMPANY,
      bridge: {
        system: {
          chooseDirectory: () => {
            asked += 1
            return new Promise((resolve) => {
              answer = resolve
            })
          },
        },
      },
    })

    await user.click(screen.getByRole('button', { name: 'first' }))
    await user.click(screen.getByRole('button', { name: 'second' }))

    expect(asked).toBe(1)
    expect(screen.getByText(/^busy:/)).toHaveTextContent('busy: yes')
    expect(screen.getByText(/^command:/)).toHaveTextContent('command: disabled')

    await act(async () => {
      answer({ ok: true, data: null })
      await Promise.resolve()
    })

    expect(screen.getByText(/^busy:/)).toHaveTextContent('busy: no')
    expect(screen.getByText(/^command:/)).toHaveTextContent('command: ready')
  })

  /* Backing up the books is meaningless from the picker. */
  it('offers the command only while a company is open', () => {
    renderScreen(<Controls />, { company: null })

    expect(screen.getByText(/^command:/)).toHaveTextContent('command: absent')
  })
})
