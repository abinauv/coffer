/*
 * Who these books belong to.
 *
 * The screen behind `COMPANY_PROFILE_MISSING`. A document cannot be drafted until this
 * exists, because the regime is asked for tax with the company as the supplier and the
 * party as the customer, and there is no supplier until somebody has said who they are.
 * Until this batch that was a sentence with nowhere to go.
 *
 * A PAGE, NOT A DIALOG — unlike ./Parties.tsx, and the difference is the record. There
 * are many parties and one profile: nothing lists it, nothing picks one, and a modal over
 * an empty screen would be a modal that can never be dismissed to anything.
 *
 * SAVING IS A REPLACE, NOT A PATCH (see `SaveCompanyProfileInput`). A field left out is a
 * field cleared, which is safe here for exactly one reason: this form holds every field
 * of the profile and always sends every one of them. If a field is ever added to the DTO
 * and not to this form, saving from here will silently clear it — so the form and the
 * shape have to be read together, and the test at the bottom of CompanyProfile.test.tsx
 * says so by asserting the whole payload rather than the fields it happens to care about.
 *
 * NO SAMPLE VALUES AS PLACEHOLDERS (B13). "Acme Traders Private Limited" and a whole GSTIN sat
 * in the empty boxes, and on an empty form — in dark above all, where a placeholder and a value
 * are one ink step apart — they read as details already filled in. The hints say what goes in
 * each box instead, and Country is a picker of names rather than a box asking for a code.
 *
 * WHAT IS NOT VALIDATED HERE. Whether `33AABCC1234D1ZI` is a real GSTIN is the regime's
 * question, asked in the main process, and its answer is a sentence written for the user.
 * The renderer does not know that an Indian registration number encodes a state, and must
 * not learn: a second, weaker check here would either disagree with main or repeat it.
 * The jurisdiction below is a plain picker over what `regime.describe()` listed, and what
 * happens when it disagrees with the number is main's to say.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import { Button, Input, Kbd, Select } from '@renderer/components/atoms'
import { callApi } from '@renderer/lib/api'
import type { Command } from '@renderer/lib/command-registry'
import { registerScreens } from '@renderer/lib/screens'
import { SHORTCUTS } from '@renderer/lib/shortcuts'
import { useRegisterCommands } from '@renderer/store/commands'
import { useRegime } from '@renderer/store/regime'
import { useToasts } from '@renderer/store/toasts'
import type { AppError, CompanyProfile as Profile, RegimeDescription } from '@shared/dto'
import { CountrySelect } from '../components/CountrySelect'
import { FailureNotice } from '../components/FailureNotice'
import { Notice } from '../components/Notice'
import { ScreenFrame } from '../components/ScreenFrame'

/** Every editable field, as strings. A form holds text; the DTO's nulls are made on save. */
interface Draft {
  legalName: string
  tradeName: string
  registrationNumber: string
  jurisdictionCode: string
  countryCode: string
  addressLine1: string
  addressLine2: string
  city: string
  postalCode: string
  email: string
  phone: string
}

/**
 * A blank profile, for books nobody has filled in yet.
 *
 * `countryCode` is seeded from the regime's id, which `RegimeId` documents as an ISO
 * 3166-1 alpha-2 code — and only when it looks like one. A regime named `eu-vat` is not
 * a country, and putting that in the field would be worse than leaving it empty: a
 * default the user has to notice and correct is a default that will be saved wrong.
 */
function blankDraft(regime: RegimeDescription | null): Draft {
  const code = regime?.id ?? ''
  return {
    legalName: '',
    tradeName: '',
    registrationNumber: '',
    jurisdictionCode: '',
    countryCode: code.length === 2 ? code : '',
    addressLine1: '',
    addressLine2: '',
    city: '',
    postalCode: '',
    email: '',
    phone: '',
  }
}

function draftOf(profile: Profile): Draft {
  return {
    legalName: profile.legalName,
    tradeName: profile.tradeName ?? '',
    registrationNumber: profile.registrationNumber ?? '',
    jurisdictionCode: profile.jurisdictionCode ?? '',
    countryCode: profile.countryCode,
    addressLine1: profile.addressLine1 ?? '',
    addressLine2: profile.addressLine2 ?? '',
    city: profile.city ?? '',
    postalCode: profile.postalCode ?? '',
    email: profile.email ?? '',
    phone: profile.phone ?? '',
  }
}

export function CompanyProfile(): JSX.Element {
  const { show } = useToasts()
  const regime = useRegime()

  const [profile, setProfile] = useState<Profile | null | 'unread'>('unread')
  const [draft, setDraft] = useState<Draft>(() => blankDraft(regime))
  const [error, setError] = useState<AppError | null>(null)
  const [isBusy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const result = await callApi((api) => api.companyProfile.get())
    if (!result.ok) {
      setError(result.error)
      return
    }
    setError(null)
    setProfile(result.data)
    setDraft(result.data === null ? blankDraft(regime) : draftOf(result.data))
  }, [regime])

  useEffect(() => {
    void load()
  }, [load])

  const set = useCallback(
    <K extends keyof Draft>(field: K, value: string) =>
      setDraft((current) => ({ ...current, [field]: value })),
    [],
  )

  /* The two the table refuses to be without — see migration 0011. Everything else is
   * genuinely optional for a small business, including the registration number. */
  const canSave = draft.legalName.trim() !== '' && draft.countryCode.trim() !== '' && !isBusy

  const save = useCallback(async () => {
    if (!canSave) return
    setBusy(true)
    setError(null)

    /*
     * EVERY FIELD, EVERY TIME. A save is a replace, so a field omitted here is a field
     * cleared in the books. Written out rather than spread so that adding one to `Draft`
     * without adding it here fails to compile.
     */
    const result = await callApi((api) =>
      api.companyProfile.save({
        legalName: draft.legalName.trim(),
        countryCode: draft.countryCode.trim(),
        tradeName: draft.tradeName.trim(),
        registrationNumber: draft.registrationNumber.trim(),
        jurisdictionCode: draft.jurisdictionCode.trim(),
        addressLine1: draft.addressLine1.trim(),
        addressLine2: draft.addressLine2.trim(),
        city: draft.city.trim(),
        postalCode: draft.postalCode.trim(),
        email: draft.email.trim(),
        phone: draft.phone.trim(),
      }),
    )
    setBusy(false)

    if (!result.ok) {
      setError(result.error)
      return
    }

    /* Redrawn from what main stored, not from what was typed. The jurisdiction may have
     * been filled in from the registration number, and a form still showing the blank
     * the user left would hide that it had been answered. */
    setProfile(result.data)
    setDraft(draftOf(result.data))
    show({
      tone: 'success',
      title: 'Saved',
      body: `These books belong to ${result.data.legalName}.`,
    })
  }, [canSave, draft, show])

  /*
   * ONE COMMAND: Save, so that Ctrl S means the same thing here as in an editor. The
   * screen is otherwise reachable by the registry's own "Go to Business details", and it
   * has no second verb. Through a ref, because `save` is rebuilt on every keystroke.
   */
  const latestSave = useRef(save)
  latestSave.current = save

  useRegisterCommands(
    useMemo<Command[]>(
      () => [
        {
          id: 'company.profile.save',
          title: 'Save the business details',
          section: 'Company',
          keywords: ['save', 'business', 'details', 'profile'],
          shortcut: SHORTCUTS.save,
          isDisabled: !canSave,
          run: () => void latestSave.current(),
        },
      ],
      [canSave],
    ),
  )

  const jurisdictions = regime?.jurisdictions ?? []

  return (
    <ScreenFrame
      isInset
      width="form"
      title="Business details"
      lede="Who these books belong to. This is the supplier on every invoice they raise, and what decides the tax on it."
    >
      <div className="stack">
        {error && <FailureNotice error={error} context="ledger" />}

        {profile === null && (
          <Notice tone="info" title="Nothing here yet">
            <p>
              An invoice needs a supplier before it can be taxed, and that is this. Fill in the
              legal name and, if the business is registered, its registration number — the rest can
              wait.
            </p>
          </Notice>
        )}

        {profile === 'unread' ? (
          <p className="prose prose--muted">Reading the business details…</p>
        ) : (
          <form
            className="stack"
            onSubmit={(event) => {
              event.preventDefault()
              void save()
            }}
          >
            <Input
              label="Legal name"
              value={draft.legalName}
              onChange={(event) => set('legalName', event.target.value)}
              hint="As it appears on the registration. This is what prints on a tax invoice."
              required
            />

            <Input
              label="Trade name"
              value={draft.tradeName}
              onChange={(event) => set('tradeName', event.target.value)}
              hint="Only if the business trades under a different name."
            />

            <Input
              label="Registration number"
              isIdentifier
              value={draft.registrationNumber}
              onChange={(event) => set('registrationNumber', event.target.value)}
              hint={
                regime === null
                  ? 'Leave blank if the business is not registered.'
                  : `${regime.label}. Leave blank if the business is not registered — that is an ordinary state, not a missing field.`
              }
            />

            {/*
             * The `Select` atom, which is this block generalised. It began as a
             * hand-rolled `<label className="field">` with the hint INSIDE the label,
             * which made the whole paragraph part of the field's accessible name. The
             * same mistake was then made again in the invoice editor, so the skeleton
             * moved into an atom where it can only be built one way.
             *
             * The hint is said in words rather than enforced in code: main fills this in
             * from the registration number where the number encodes it, and refuses a
             * pair that disagree. The renderer does not know which numbers encode what.
             */}
            <Select
              label="State or region"
              value={draft.jurisdictionCode}
              hint="Filled in from the registration number when there is one. Getting this wrong changes the tax on every invoice these books raise, in both directions."
              onChange={(event) => set('jurisdictionCode', event.target.value)}
            >
              <option value="">Not set</option>
              {jurisdictions.map((jurisdiction) => (
                <option key={jurisdiction.code} value={jurisdiction.code}>
                  {jurisdiction.name}
                </option>
              ))}
            </Select>

            <CountrySelect
              value={draft.countryCode}
              onChange={(code) => set('countryCode', code)}
              hint="Where the business is. Every party starts in this country."
            />

            <Input
              label="Address"
              value={draft.addressLine1}
              onChange={(event) => set('addressLine1', event.target.value)}
            />

            <Input
              label="Address, continued"
              isLabelHidden
              value={draft.addressLine2}
              onChange={(event) => set('addressLine2', event.target.value)}
            />

            <Input
              label="City"
              value={draft.city}
              onChange={(event) => set('city', event.target.value)}
            />

            <Input
              label="Postal code"
              value={draft.postalCode}
              onChange={(event) => set('postalCode', event.target.value)}
            />

            <Input
              label="Email"
              type="email"
              value={draft.email}
              onChange={(event) => set('email', event.target.value)}
            />

            <Input
              label="Phone"
              value={draft.phone}
              onChange={(event) => set('phone', event.target.value)}
            />

            <div className="toolbar">
              <Button
                type="submit"
                variant="primary"
                disabled={!canSave}
                aria-keyshortcuts="Control+S"
              >
                {isBusy ? 'Saving…' : 'Save'}
                <span className="button__keys" aria-hidden="true">
                  <Kbd shortcut={SHORTCUTS.save} />
                </span>
              </Button>
            </div>
          </form>
        )}
      </div>
    </ScreenFrame>
  )
}

registerScreens([
  {
    id: 'company-profile',
    title: 'Business details',
    area: 'workspace',
    nav: { label: 'Business details', icon: 'building', group: 'company', order: 0 },
    render: () => <CompanyProfile />,
  },
])
