/*
 * Company → Backups.
 *
 * A Coffer backup is one file holding the encrypted database and the vault beside it. It
 * is not a copy in a different format and not a partial export: restoring it gives back
 * the books exactly as they were, and needs the passphrase they had that day.
 *
 * WHAT THIS SCREEN WILL NOT SAY. It never says "your books are safe", and it never says a
 * backup still exists. Coffer wrote a file to a folder somebody chose; that folder may be
 * a USB stick in a drawer or a synced drive that has since been tidied, and this process
 * has not looked at it since. So every sentence is about what was written and when — the
 * path is on screen so a person can go and check the only thing that settles it.
 *
 * THE REMINDER IS PER COMPANY, in the registry. An accountant with six clients' books on
 * one machine has a different answer for each, and the reminder is about a file rather
 * than about a person. `storage.ts` forbids company data in localStorage, and a path into
 * somebody's filesystem is company data.
 */

import { useCallback, useState } from 'react'
import type { JSX } from 'react'
import { Button } from '@renderer/components/atoms'
import { callApi } from '@renderer/lib/api'
import { registerScreens } from '@renderer/lib/screens'
import { useBackup } from '@renderer/store/backup'
import { useCompany } from '@renderer/store/company'
import { useToasts } from '@renderer/store/toasts'
import { CheckboxField } from '../components/CheckboxField'
import { EmptyState } from '../components/EmptyState'
import { Notice } from '../components/Notice'
import { RestoreDialog } from '../components/RestoreDialog'
import { ScreenFrame } from '../components/ScreenFrame'
import { BACKUP_REMINDER_DAYS, isBackupOverdue, lastBackupLine } from '../lib/backup-view'
import { failureTitle } from '../lib/messages'

export function Backups(): JSX.Element {
  const { company, update } = useCompany()
  const { backUp, isBackingUp } = useBackup()
  const { show } = useToasts()
  const [isRestoreOpen, setRestoreOpen] = useState(false)
  const [isSavingReminder, setSavingReminder] = useState(false)

  const setReminder = useCallback(
    async (isOn: boolean) => {
      if (company === null) return
      setSavingReminder(true)
      const result = await callApi((api) =>
        api.companies.setBackupReminder({ id: company.id, isOn }),
      )
      setSavingReminder(false)
      if (!result.ok) {
        show({ tone: 'danger', title: failureTitle(result.error), body: result.error.message })
        return
      }
      update(result.data)
    },
    [company, show, update],
  )

  const reveal = useCallback((path: string) => {
    void callApi((api) => api.system.revealInFileManager(path))
  }, [])

  /* The shell only draws this screen with a company open; the guard is for the type. */
  if (company === null) {
    return (
      <ScreenFrame isInset width="form" title="Backups">
        <EmptyState title="No company is open" titleAs="h2">
          <p>Open a company to back it up.</p>
        </EmptyState>
      </ScreenFrame>
    )
  }

  const backup = company.lastBackup

  return (
    <ScreenFrame
      isInset
      width="form"
      title="Backups"
      lede="One file holding these books and the keys to them. Written where you choose, restored with the passphrase they had that day."
      actions={
        <Button variant="primary" icon="archive" isBusy={isBackingUp} onClick={() => void backUp()}>
          Back up now
        </Button>
      }
    >
      <div className="stack">
        <section className="fact" aria-labelledby="last-backup">
          <span className="fact__label" id="last-backup">
            Last backup
          </span>
          <p className="prose">{lastBackupLine(backup)}</p>
          {backup === null ? (
            <p className="prose prose--muted">
              Nothing has been written from this machine. A backup taken now holds everything in the
              books as they stand.
            </p>
          ) : (
            <>
              <p className="prose prose--muted selectable">{backup.path}</p>
              {/* Coffer has not looked at that folder since it wrote there, and says so
                  rather than implying the file is still in it. */}
              <p className="prose prose--muted">
                That is where it was written. Coffer has not looked since — open the folder if you
                want to be sure it is still there.
              </p>
              <div className="actions">
                <Button size="sm" onClick={() => reveal(backup.path)}>
                  Show in folder
                </Button>
              </div>
            </>
          )}
        </section>

        {isBackupOverdue(company) && (
          <Notice tone="warning" title="It has been a while">
            <p>
              Everything entered since the last backup exists only on this machine. A backup takes a
              few seconds and can go on a USB stick.
            </p>
          </Notice>
        )}

        <CheckboxField
          isChecked={company.remindsAboutBackups}
          isDisabled={isSavingReminder}
          onChange={(isOn) => void setReminder(isOn)}
          hint="The Overview says so under “Needs your attention”. Nothing is sent anywhere, and nothing happens on its own."
        >
          Remind me if no backup has been written for {BACKUP_REMINDER_DAYS} days
        </CheckboxField>

        <section className="stack stack--tight" aria-labelledby="what-a-backup-is">
          <h2 className="caps-label" id="what-a-backup-is">
            What a backup holds
          </h2>
          <p className="prose">
            The same encrypted database this company lives in, and the vault file beside it. Both
            are needed: the vault holds the wrapped key, and the database without it is a file
            nobody can open — not you, and not anybody who takes the disk.
          </p>
          <p className="prose">
            It is encrypted exactly as the original is, so a backup on a shared drive is as safe as
            the passphrase. Keep one copy somewhere other than this machine: a drive that fails
            takes the books and the backup beside them together.
          </p>
        </section>

        <section className="stack stack--tight" aria-labelledby="restoring">
          <h2 className="caps-label" id="restoring">
            Restoring
          </h2>
          <p className="prose">
            A restored backup arrives as a separate company in your list, in a folder you choose. It
            never replaces the books that are open, and it opens with the passphrase they had when
            the backup was taken — recovery codes from that day still work.
          </p>
          <div className="actions">
            <Button onClick={() => setRestoreOpen(true)}>Restore from a backup</Button>
          </div>
        </section>
      </div>

      <RestoreDialog
        isOpen={isRestoreOpen}
        onClose={() => setRestoreOpen(false)}
        onDone={() => Promise.resolve()}
      />
    </ScreenFrame>
  )
}

registerScreens([
  {
    id: 'backups',
    title: 'Backups',
    area: 'workspace',
    nav: { label: 'Backups', icon: 'archive', group: 'company', order: 2 },
    render: () => <Backups />,
  },
])
