/*
 * Company → Backups, rendered.
 *
 * `backup-view.ts` is covered as pure functions next door. What is covered only here is
 * what the screen does with them, and the one thing it must never do: claim that a file
 * Coffer wrote is still on disk. It says when an archive was written and where it went,
 * and the path is on screen so the user can go and settle it themselves.
 */

import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { CompanySummary } from '@shared/dto'
import { DEFAULT_COMPANY, renderScreen, type BridgeStub } from '../../test/harness'
import { Backups } from './Backups'

const daysAgo = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString()

function company(over: Partial<CompanySummary> = {}): CompanySummary {
  return { ...DEFAULT_COMPANY, createdAt: daysAgo(60), ...over }
}

const BACKED_UP = company({
  lastBackup: {
    at: daysAgo(2),
    path: '/backups/Acme-Traders.coffer-backup.zip',
    sizeBytes: 2_400_000,
  },
})

function bridge(over: BridgeStub = {}): BridgeStub {
  return {
    system: {
      chooseDirectory: () => Promise.resolve({ ok: true, data: '/backups' }),
      revealInFileManager: () => Promise.resolve({ ok: true, data: undefined }),
    },
    companies: {
      backup: () =>
        Promise.resolve({
          ok: true,
          data: {
            archivePath: '/backups/new.coffer-backup.zip',
            sizeBytes: 3_000_000,
            createdAt: new Date().toISOString(),
            company: company({
              lastBackup: {
                at: new Date().toISOString(),
                path: '/backups/new.coffer-backup.zip',
                sizeBytes: 3_000_000,
              },
            }),
          },
        }),
      setBackupReminder: () =>
        Promise.resolve({ ok: true, data: company({ remindsAboutBackups: false }) }),
    },
    ...over,
  }
}

describe('what it says about the last backup', () => {
  it('says when it was written, how big it was, and where it went', async () => {
    renderScreen(<Backups />, { bridge: bridge(), company: BACKED_UP })

    expect(await screen.findByText('Written 2 days ago · 2.3 MB')).toBeInTheDocument()
    expect(screen.getByText('/backups/Acme-Traders.coffer-backup.zip')).toBeInTheDocument()
  })

  /*
   * THE CLAIM THIS SCREEN MUST NOT MAKE. Coffer wrote a file into a folder somebody
   * chose and has not looked at it since. "Your books are backed up" would be a promise
   * about a USB stick in a drawer.
   */
  it('says only that it has not looked since', async () => {
    renderScreen(<Backups />, { bridge: bridge(), company: BACKED_UP })

    expect(await screen.findByText(/Coffer has not looked since/)).toBeInTheDocument()
    expect(screen.queryByText(/your books are safe/i)).toBeNull()
    expect(screen.queryByText(/backed up and safe/i)).toBeNull()
  })

  it('says plainly when nothing has been written from this machine', async () => {
    renderScreen(<Backups />, { bridge: bridge(), company: company({ lastBackup: null }) })

    expect(
      await screen.findByText('No backup has been written from this machine'),
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Show in folder' })).toBeNull()
  })

  it('opens the folder the archive went into', async () => {
    const user = userEvent.setup()
    const { bridge: fake } = renderScreen(<Backups />, { bridge: bridge(), company: BACKED_UP })

    await user.click(await screen.findByRole('button', { name: 'Show in folder' }))

    expect(fake.lastCallTo('system:revealInFileManager')?.args[0]).toBe(
      '/backups/Acme-Traders.coffer-backup.zip',
    )
  })
})

describe('backing up from here', () => {
  it('writes an archive and then says it was written today', async () => {
    const user = userEvent.setup()
    const { bridge: fake } = renderScreen(<Backups />, {
      bridge: bridge(),
      company: company({ lastBackup: { at: daysAgo(30), path: '/old.zip', sizeBytes: 10 } }),
    })

    await user.click(await screen.findByRole('button', { name: 'Back up now' }))

    await waitFor(() => expect(fake.callsTo('companies:backup')).toHaveLength(1))
    /* Main handed the company back with the archive; the screen adopted it. */
    expect(await screen.findByText(/Written today/)).toBeInTheDocument()
  })
})

describe('the reminder', () => {
  it('is on by default and says how long it waits', async () => {
    renderScreen(<Backups />, { bridge: bridge(), company: BACKED_UP })

    const toggle = await screen.findByRole('checkbox', {
      name: 'Remind me if no backup has been written for 7 days',
    })
    expect(toggle).toBeChecked()
  })

  it('sends the answer to main, and takes main’s word for what it now is', async () => {
    const user = userEvent.setup()
    const { bridge: fake } = renderScreen(<Backups />, { bridge: bridge(), company: BACKED_UP })

    await user.click(await screen.findByRole('checkbox', { name: /Remind me/ }))

    await waitFor(() =>
      expect(fake.lastCallTo('companies:setBackupReminder')?.args[0]).toEqual({
        id: 'acme',
        isOn: false,
      }),
    )
    await waitFor(() =>
      expect(screen.getByRole('checkbox', { name: /Remind me/ })).not.toBeChecked(),
    )
  })

  it('keeps the box as it was when main refuses', async () => {
    const user = userEvent.setup()
    renderScreen(<Backups />, {
      bridge: bridge({
        companies: {
          setBackupReminder: () =>
            Promise.resolve({
              ok: false,
              error: { code: 'COMPANY_NOT_FOUND', message: 'That company is not in the list.' },
            }),
        },
      }),
      company: BACKED_UP,
    })

    await user.click(await screen.findByRole('checkbox', { name: /Remind me/ }))

    expect(await screen.findByText('That company is not in the list.')).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: /Remind me/ })).toBeChecked()
  })
})

describe('when it has been a while', () => {
  it('says so on the screen as well as on the Overview', async () => {
    renderScreen(<Backups />, {
      bridge: bridge(),
      company: company({ lastBackup: { at: daysAgo(20), path: '/old.zip', sizeBytes: 10 } }),
    })

    expect(await screen.findByText('It has been a while')).toBeInTheDocument()
  })

  it('says nothing of the sort about a recent one', async () => {
    renderScreen(<Backups />, { bridge: bridge(), company: BACKED_UP })

    await screen.findByText(/Written 2 days ago/)
    expect(screen.queryByText('It has been a while')).toBeNull()
  })
})

describe('restoring', () => {
  /* A restored backup is a separate company. It never replaces the books that are open —
   * which is why this screen can offer it at all. */
  it('opens the same dialog the picker offers, and says what restoring does', async () => {
    const user = userEvent.setup()
    renderScreen(<Backups />, { bridge: bridge(), company: BACKED_UP })

    await user.click(await screen.findByRole('button', { name: 'Restore from a backup…' }))

    const dialog = await screen.findByRole('dialog', { name: 'Restore from a backup' })
    expect(within(dialog).getByText(/does not open the company/)).toBeInTheDocument()
  })
})
