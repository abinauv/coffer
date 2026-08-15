/*
 * Unlocking a company.
 *
 * One field, and a great deal of care about what happens when it does not work. The four
 * failures a user actually meets here are genuinely different situations and get
 * genuinely different screens (../lib/messages.ts has the copy):
 *
 *   PASSPHRASE_INVALID        the passphrase did not fit. Offer recovery.
 *   COMPANY_DATABASE_MISSING  the file is not there. Connect the drive, or find it again.
 *   COMPANY_VAULT_MISSING     the keys are gone. Only a backup holding both files helps.
 *   COMPANY_KEYS_MISMATCHED   the vault opened but belongs to different books.
 *
 * The last one is the one a lazy screen collapses into "wrong passphrase", which would
 * send somebody hunting for a passphrase that was never the problem.
 */

import { useCallback, useState } from 'react'
import type { JSX } from 'react'
import { Button, Icon } from '@renderer/components/atoms'
import { callApi } from '@renderer/lib/api'
import { makeRoute } from '@renderer/lib/routing'
import { useCompany } from '@renderer/store/company'
import { useNavigation } from '@renderer/store/navigation'
import { registerScreens } from '@renderer/lib/screens'
import type { AppError } from '@shared/dto'
import { FailureNotice } from '../components/FailureNotice'
import { Notice } from '../components/Notice'
import { PassphraseField } from '../components/PassphraseField'
import { ScreenFrame } from '../components/ScreenFrame'
import { describeAvailability } from '../lib/availability'
import { describeLastOpened } from '../lib/dates'
import { validateUnlock } from '../lib/forms'
import { findCompany, useCompanies } from '../lib/use-companies'

export function UnlockCompany(): JSX.Element {
  const { route, navigate } = useNavigation()
  const { adopt } = useCompany()
  const { companies, isLoading, refresh } = useCompanies()

  const id = route.params['id']
  const company = findCompany(companies, id)

  const [passphrase, setPassphrase] = useState('')
  const [isBusy, setBusy] = useState(false)
  const [error, setError] = useState<AppError | null>(null)

  const form = validateUnlock(passphrase)
  const toCompanies = useCallback(
    (action?: string) =>
      navigate(makeRoute('welcome', 'companies', action === undefined ? {} : { action })),
    [navigate],
  )
  const toRecovery = useCallback(() => {
    if (id !== undefined) navigate(makeRoute('welcome', 'recover', { id }))
  }, [id, navigate])

  const submit = useCallback(async () => {
    if (company === null || !form.canSubmit || isBusy) return
    setBusy(true)
    setError(null)
    const result = await callApi((api) => api.companies.open({ id: company.id, passphrase }))
    setBusy(false)

    if (!result.ok) {
      setError(result.error)
      return
    }
    /* Cleared before the shell switches areas — there is no reason for it to survive the
     * unlock that used it. */
    setPassphrase('')
    adopt(result.data)
  }, [company, form.canSubmit, isBusy, passphrase, adopt])

  const back = { label: 'All companies', onClick: () => toCompanies() }

  if (companies === null) {
    return (
      <ScreenFrame title="Opening a company" back={back}>
        <p className="prose prose--muted">{isLoading ? 'Reading your list…' : ''}</p>
      </ScreenFrame>
    )
  }

  if (company === null) {
    return (
      <ScreenFrame title="That company is not in your list" back={back}>
        <Notice tone="warning" title="Coffer has no company with that identifier">
          <p>
            It was removed from the list, or this window is showing something older than the list
            is. Nothing has been deleted — company files are never touched by removing an entry. Go
            back and add it again from wherever it is kept.
          </p>
        </Notice>
      </ScreenFrame>
    )
  }

  const availability = describeAvailability(company)

  return (
    <ScreenFrame
      title={`Open ${company.displayName}`}
      lede={
        <>
          <span className="selectable">{company.filePath}</span>
          {' · '}
          {describeLastOpened(company.lastOpenedAt)}
        </>
      }
      back={back}
    >
      <div className="stack">
        {!availability.canOpen && availability.headline !== null && (
          <Notice
            tone={company.availability === 'vault-missing' ? 'danger' : 'warning'}
            title={availability.headline}
            actions={
              <>
                <Button size="sm" onClick={() => void refresh()}>
                  Check again
                </Button>
                <Button
                  size="sm"
                  onClick={() =>
                    toCompanies(availability.action === 'restore' ? 'restore' : undefined)
                  }
                >
                  {availability.action === 'restore' ? 'Restore from a backup' : 'Find the file'}
                </Button>
              </>
            }
          >
            <p>{availability.body}</p>
          </Notice>
        )}

        {error && (
          <FailureNotice
            error={error}
            context="unlock"
            onAction={{
              recover: toRecovery,
              refresh: () => void refresh(),
              restore: () => toCompanies('restore'),
              'add-existing': () => toCompanies(),
            }}
          />
        )}

        {availability.canOpen && (
          <>
            <PassphraseField
              label="Passphrase"
              value={passphrase}
              onChange={setPassphrase}
              error={form.errors.passphrase}
              hint="The passphrase you chose when this company was created, or the one you set the last time you used a recovery code."
              autoFocus
              isDisabled={isBusy}
              onSubmit={() => void submit()}
            />

            <div className="actions">
              <Button
                variant="primary"
                icon="lock"
                onClick={() => void submit()}
                disabled={!form.canSubmit}
                isBusy={isBusy}
              >
                Unlock
              </Button>
              <Button variant="ghost" onClick={toRecovery}>
                Use a recovery code
              </Button>
            </div>

            <p className="prose prose--muted">
              <Icon name="info" size={13} className="prose__icon" /> Checking a passphrase is
              deliberately slow — a fraction of a second here is what makes guessing it in bulk
              impractical.
            </p>
          </>
        )}
      </div>
    </ScreenFrame>
  )
}

registerScreens([
  {
    id: 'unlock',
    title: 'Open a company',
    area: 'welcome',
    render: () => <UnlockCompany />,
  },
])
