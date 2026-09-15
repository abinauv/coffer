/*
 * Unlocking with a recovery code.
 *
 * Recovery spends one code and sets a new passphrase — both, always, in one step. That is
 * main's design (src/main/companies/service.ts) and it is the right one: a code that
 * unlocked without re-establishing a passphrase would leave the user in the same position
 * they were in a minute ago, with one fewer code.
 *
 * A fresh set is NOT issued. The other four codes on the sheet keep working, which is why
 * the screen tells the user how many are left rather than telling them to reprint
 * anything. Nought left is a state worth interrupting over.
 */

import { useCallback, useEffect, useState } from 'react'
import type { JSX } from 'react'
import { Button, Input } from '@renderer/components/atoms'
import { callApi } from '@renderer/lib/api'
import { makeRoute } from '@renderer/lib/routing'
import { useCompany } from '@renderer/store/company'
import { useNavigation } from '@renderer/store/navigation'
import { registerScreens } from '@renderer/lib/screens'
import { useToasts } from '@renderer/store/toasts'
import type { AppError, PassphraseStrength } from '@shared/dto'
import { FailureNotice } from '../components/FailureNotice'
import { Notice } from '../components/Notice'
import { PassphraseField } from '../components/PassphraseField'
import { ScreenFrame } from '../components/ScreenFrame'
import { StepCard } from '../components/StepFrame'
import { StrengthMeter } from '../components/StrengthMeter'
import { validateRecover } from '../lib/forms'
import { NO_RESET_WARNING } from '../lib/passphrase-meter'
import { remainingCodesNotice } from '../lib/recovery-sheet'
import { findCompany, useCompanies } from '../lib/use-companies'

const STRENGTH_DEBOUNCE_MS = 160

export function RecoverCompany(): JSX.Element {
  const { route, navigate } = useNavigation()
  const { adopt } = useCompany()
  const { show } = useToasts()
  const { companies } = useCompanies()

  const id = route.params['id']
  const company = findCompany(companies, id)

  const [recoveryCode, setRecoveryCode] = useState('')
  const [newPassphrase, setNewPassphrase] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [hasTouchedConfirmation, setTouchedConfirmation] = useState(false)
  const [strength, setStrength] = useState<PassphraseStrength | null>(null)
  const [isBusy, setBusy] = useState(false)
  const [error, setError] = useState<AppError | null>(null)

  const form = validateRecover(
    { recoveryCode, newPassphrase, confirmation },
    hasTouchedConfirmation,
  )

  useEffect(() => {
    if (newPassphrase === '') {
      setStrength(null)
      return undefined
    }
    let isActive = true
    const handle = setTimeout(() => {
      void callApi((api) => api.companies.checkPassphrase(newPassphrase)).then((result) => {
        if (isActive && result.ok) setStrength(result.data)
      })
    }, STRENGTH_DEBOUNCE_MS)
    return () => {
      isActive = false
      clearTimeout(handle)
    }
  }, [newPassphrase])

  const toCompanies = useCallback(() => navigate(makeRoute('welcome', 'companies')), [navigate])

  const submit = useCallback(async () => {
    if (company === null || !form.canSubmit || isBusy) return
    setBusy(true)
    setError(null)
    const result = await callApi((api) =>
      api.companies.recover({
        id: company.id,
        recoveryCode: recoveryCode.trim(),
        newPassphrase,
      }),
    )
    setBusy(false)

    if (!result.ok) {
      setError(result.error)
      return
    }

    setRecoveryCode('')
    setNewPassphrase('')
    setConfirmation('')

    /* The count only exists after a successful recovery — before it, nothing has read
     * the vault. So this is the moment to say how many are left, and the toast stays up
     * until it is dismissed when the answer is nought. */
    const notice = remainingCodesNotice(result.data.recoveryCodesRemaining)
    show({
      tone: result.data.recoveryCodesRemaining === 0 ? 'warning' : 'info',
      title: notice.title,
      body: notice.body,
      durationMs: result.data.recoveryCodesRemaining === 0 ? null : undefined,
    })
    adopt(result.data)
  }, [company, form.canSubmit, isBusy, recoveryCode, newPassphrase, adopt, show])

  const back = { label: 'All companies', onClick: toCompanies }

  if (companies === null) {
    return (
      <ScreenFrame title="Use a recovery code" back={back}>
        <p className="prose prose--muted">Reading your list…</p>
      </ScreenFrame>
    )
  }

  if (company === null) {
    return (
      <ScreenFrame title="That company is not in your list" back={back}>
        <Notice tone="warning" title="Coffer has no company with that identifier">
          <p>
            Go back and choose the company you want to recover. Nothing has been deleted — an entry
            can be added again from the file itself.
          </p>
        </Notice>
      </ScreenFrame>
    )
  }

  return (
    <ScreenFrame
      width="list"
      title={`Recover ${company.displayName}`}
      lede="A recovery code opens this company without the passphrase, once. It is then spent, and you choose the passphrase you will use from now on."
      back={back}
    >
      <div className="split">
        <div className="stack">
          {error && (
            <FailureNotice
              error={error}
              context="recover"
              onAction={{
                restore: toCompanies,
                'add-existing': toCompanies,
              }}
            />
          )}

          <Input
            label="Recovery code"
            isIdentifier
            value={recoveryCode}
            error={form.errors.recoveryCode}
            hint="From the sheet you saved when this company was created. Hyphens, spaces and lower case are all fine."
            placeholder="A1B2C-3D4E5-F6G7H-8J9K0"
            autoComplete="off"
            spellCheck={false}
            autoFocus
            onChange={(event) => setRecoveryCode(event.target.value)}
          />

          <PassphraseField
            label="New passphrase"
            value={newPassphrase}
            onChange={setNewPassphrase}
            error={form.errors.newPassphrase}
            hint="This replaces the passphrase you could not use. The books themselves are not re-encrypted, so this is quick."
            isDisabled={isBusy}
            onSubmit={() => void submit()}
          >
            <StrengthMeter strength={strength} passphrase={newPassphrase} />
          </PassphraseField>

          <PassphraseField
            label="Type it again"
            value={confirmation}
            onChange={(value) => {
              setConfirmation(value)
              setTouchedConfirmation(true)
            }}
            error={form.errors.confirmation}
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
              Recover and open
            </Button>
          </div>
        </div>

        <aside className="split__aside">
          <StepCard title="The code you use is gone afterwards" tone="warning">
            <p>
              Each code works exactly once. The others on your sheet keep working, and Coffer cannot
              issue replacements for a company that already exists — so cross this one off the sheet
              once it has worked.
            </p>
          </StepCard>
          <StepCard title="There is no back door">
            <p>{NO_RESET_WARNING}</p>
          </StepCard>
        </aside>
      </div>
    </ScreenFrame>
  )
}

registerScreens([
  {
    id: 'recover',
    title: 'Use a recovery code',
    area: 'welcome',
    render: () => <RecoverCompany />,
  },
])
