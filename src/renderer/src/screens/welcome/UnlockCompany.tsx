/*
 * Unlocking a company.
 *
 * One field, and a great deal of care about what happens when it does not work. The four
 * failures a user actually meets here are genuinely different situations and get genuinely
 * different states, each with its cause, its fix and only the actions that could fix it
 * (../lib/unlock-failures.ts has the words):
 *
 *   PASSPHRASE_INVALID        the passphrase did not fit. Offer recovery; keep the field.
 *   COMPANY_DATABASE_MISSING  the file is not there. Connect the drive, or find it again.
 *   COMPANY_VAULT_MISSING     the keys are gone. Only a backup holding both files helps.
 *   COMPANY_KEYS_MISMATCHED   the vault opened but belongs to different books.
 *
 * The last one is the one a lazy screen collapses into "wrong passphrase", which would
 * send somebody hunting for a passphrase that was never the problem. Any other failure is
 * shown as the general notice for its code.
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
import { ErrorState } from '../components/ErrorState'
import { FailureNotice } from '../components/FailureNotice'
import { Notice } from '../components/Notice'
import { PassphraseField } from '../components/PassphraseField'
import { ScreenFrame } from '../components/ScreenFrame'
import { describeLastOpened } from '../lib/dates'
import { validateUnlock } from '../lib/forms'
import {
  describeUnlockFailure,
  UNLOCK_ACTION_LABELS,
  unlockFailureKind,
  type UnlockAction,
} from '../lib/unlock-failures'
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
    (params: Record<string, string> = {}) => navigate(makeRoute('welcome', 'companies', params)),
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

  const kind = unlockFailureKind(company, error)
  const failure = kind === null ? null : describeUnlockFailure(kind, company)
  const canTry = company.availability === 'ok' && (failure === null || failure.canRetry)

  const run: Record<UnlockAction, () => void> = {
    recover: toRecovery,
    refresh: () => {
      setError(null)
      void refresh()
    },
    'find-file': () => toCompanies({ action: 'add-existing' }),
    restore: () => toCompanies({ action: 'restore' }),
    forget: () => toCompanies({ action: 'forget', id: company.id }),
  }

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
        {failure !== null && (
          <ErrorState
            title={failure.title}
            cause={<p>{failure.cause}</p>}
            fix={<p>{failure.fix}</p>}
            actions={failure.actions.map((action, index) => (
              <Button
                key={action}
                variant={index === 0 ? 'primary' : 'secondary'}
                onClick={run[action]}
              >
                {UNLOCK_ACTION_LABELS[action]}
              </Button>
            ))}
          />
        )}

        {error !== null && kind === null && (
          <FailureNotice
            error={error}
            context="unlock"
            onAction={{
              recover: toRecovery,
              refresh: run.refresh,
              restore: run.restore,
              'add-existing': run['find-file'],
            }}
          />
        )}

        {canTry && (
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
              {failure === null && (
                <Button variant="ghost" onClick={toRecovery}>
                  Use a recovery code
                </Button>
              )}
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
