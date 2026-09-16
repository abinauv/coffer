/*
 * Customers and vendors.
 *
 * ONE SCREEN, THREE DOORS. `Customers` under Sales and `Vendors` under Purchases are the
 * words a business uses, and they are both this component with `role` set. Behind them is
 * one table — the firm you sell to is very often the firm you buy transport from, and two
 * screens over two tables would give that firm two balances and a set-off nobody
 * reconciles. The lede on both filtered screens says so, because somebody who only ever
 * opens Vendors would otherwise never find out.
 *
 * NO BALANCES HERE, for the same reason the chart of accounts carries none. This is who
 * the parties ARE; what they owe is a sum over the ledger and belongs with the aged
 * report it will be grouped by. A figure on every row would mean reading the whole ledger
 * to draw a masters screen, and would invite reading that screen as a report.
 *
 * ARCHIVE, NOT DELETE, is the default action. Deleting is offered only for a party
 * nothing has been posted against — the repository refuses the rest — because a customer
 * who has been invoiced is part of the books, and removing them would leave a receivable
 * owed by nobody.
 *
 * ---------------------------------------------------------------------------
 * THE EDITOR WRITES THE WHOLE RECORD, AND TWO OF THE FIELDS IT USED NOT TO WRITE WERE
 * CHANGING THE BOOKS BY BEING ABSENT.
 *
 * `jurisdictionCode` decides the place of supply, and the place of supply decides the
 * tax. A registered party gets one for free — a GSTIN's first two digits are the state
 * code and `books/registration.ts` reads them off — but an unregistered party, which is
 * most small customers, had nowhere to get one from, so every supply to them resolved as
 * crossing a state line. There is a picker now, and `isPlaceOfSupplyUnknown` is what says
 * so when the record still answers nothing.
 *
 * `paymentTermsDays` is the whole of a due date. `issuing.ts` stamps one at the moment a
 * document is issued by reading the party's terms, and no party had any, so every
 * document in the product was due on the day it was raised and the aged report bucketed
 * everything from the document date.
 *
 * SIXTEEN FIELDS IN FIVE BANDS, AND THE COMMON PATH IS THE FIRST TWO. Who they are, then
 * where they are for tax, then the terms, then the address and the contact details, then
 * anything else. A walk-in customer is a name and a state — both in the first two bands —
 * and everything a small business fills in once a year is below them, in that order. The
 * eleven fields such a customer skips are all beneath the two they need, so it is
 * scrolling past rather than tabbing through.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { JSX, ReactNode } from 'react'
import { Badge, Button, Dialog, Input, Select } from '@renderer/components/atoms'
import { callApi } from '@renderer/lib/api'
import type { Command } from '@renderer/lib/command-registry'
import { registerScreens } from '@renderer/lib/screens'
import { SHORTCUTS } from '@renderer/lib/shortcuts'
import { useRegisterCommands } from '@renderer/store/commands'
import { useRegime } from '@renderer/store/regime'
import { useToasts } from '@renderer/store/toasts'
import type { AppError, JurisdictionOption, Party, PartyRole, PartySummary } from '@shared/dto'
import { CheckboxField } from '../components/CheckboxField'
import { CountrySelect } from '../components/CountrySelect'
import { DeleteDialog } from '../components/DeleteDialog'
import { FailureNotice } from '../components/FailureNotice'
import { ListToolbar } from '../components/ListToolbar'
import { Notice } from '../components/Notice'
import { RegisterEmpty } from '../components/RegisterToolbar'
import { RegisterSkeleton, type SkeletonColumn } from '../components/RegisterSkeleton'
import { ScreenFrame } from '../components/ScreenFrame'
import { useSearchShortcut } from '../lib/use-search-shortcut'
import { archivedNote } from '../lib/register-view'
import { useHasTyped } from '../lib/typed'
import {
  blankDraft,
  copyFor,
  defaultCountryCode,
  draftOf,
  filterParties,
  isPlaceOfSupplyUnknown,
  leavesList,
  parsePaymentTerms,
  partyFieldsFrom,
  partyKindLabel,
  type PartyDraft,
} from '../lib/party-view'

/* The skeleton holds the table's own columns: name, registration, city, kind, actions. */
const COLUMNS: readonly SkeletonColumn[] = [
  { width: 'minmax(10rem, 2fr)' },
  { width: '11rem' },
  { width: '1fr' },
  { width: '6rem' },
  { width: '9rem', align: 'end' },
]

interface PartiesProps {
  /** Which side this screen was entered from. Null lists everybody. */
  role?: PartyRole | null
  /**
   * A party to open as the screen arrives — what the palette sends when a party is chosen
   * from its results. Opened once, when the screen mounts with it.
   */
  openId?: string
}

export function Parties({ role = null, openId }: PartiesProps): JSX.Element {
  const { show } = useToasts()
  const regime = useRegime()
  const copy = useMemo(() => copyFor(role), [role])

  const [parties, setParties] = useState<PartySummary[] | null>(null)
  const [error, setError] = useState<AppError | null>(null)
  const [query, setQuery] = useState('')
  const [includeArchived, setIncludeArchived] = useState(false)
  const [editing, setEditing] = useState<Party | 'new' | null>(null)
  const [deleting, setDeleting] = useState<PartySummary | null>(null)

  /*
   * WHERE A NEW PARTY'S COUNTRY COMES FROM.
   *
   * The company's own, read once. It was `'in'`, written into the call — the same class
   * of bug 2.2e-2 took out of number formatting, and fixable since 2.2e-3 put a country
   * on the profile. See `defaultCountryCode` for why the profile beats `regime.describe`
   * and why the regime is still worth asking second.
   *
   * The regime's answer seeds the state so that the field is never blank while one IPC
   * call is in flight, and a failure to read the profile leaves that seed standing rather
   * than raising a notice: this is a default for a box the user is looking at and can
   * correct, and the screen is about parties, not about the business's own details.
   */
  const [homeCountryCode, setHomeCountryCode] = useState(() => defaultCountryCode(null, regime))

  const load = useCallback(async () => {
    const result = await callApi((api) =>
      api.parties.list({ includeArchived, ...(role === null ? {} : { role }) }),
    )
    if (!result.ok) {
      setError(result.error)
      return
    }
    setError(null)
    setParties(result.data)
  }, [includeArchived, role])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    void (async () => {
      const result = await callApi((api) => api.companyProfile.get())
      if (result.ok) setHomeCountryCode(defaultCountryCode(result.data, regime))
    })()
  }, [regime])

  useRegisterCommands(
    useMemo<Command[]>(
      () => [
        {
          id: `parties.new-${role ?? 'party'}`,
          title: copy.newLabel,
          section: 'Parties',
          keywords: ['customer', 'vendor', 'party', 'create'],
          shortcut: SHORTCUTS.create,
          run: () => setEditing('new'),
        },
      ],
      [copy.newLabel, role],
    ),
  )

  /* Opening the editor needs the whole record, and the list only carries a summary. */
  const openEditor = useCallback(
    async (id: string) => {
      const result = await callApi((api) => api.parties.get(id))
      if (!result.ok) {
        setError(result.error)
        return
      }
      if (result.data === null) {
        /* Deleted in another window since the list was drawn. Reloading is the honest
         * answer — an editor over a record that is gone can only fail on save. */
        void load()
        return
      }
      setEditing(result.data)
    },
    [load],
  )

  /*
   * The route names a party to open: the palette's result, landing on its record. ONCE —
   * `openEditor` is rebuilt when the archived filter changes, and a dialog that reopened
   * every time somebody ticked Show archived would be a dialog nobody could close for good.
   */
  const openedFromRoute = useRef(false)
  useEffect(() => {
    if (openedFromRoute.current || openId === undefined || openId === '') return
    openedFromRoute.current = true
    void openEditor(openId)
  }, [openEditor, openId])

  const setArchived = useCallback(
    async (party: PartySummary, archived: boolean) => {
      const result = await callApi((api) => api.parties.archive({ id: party.id, archived }))
      if (!result.ok) {
        show({ tone: 'danger', title: 'That did not work', body: result.error.message })
        return
      }
      show({
        tone: 'success',
        title: archived ? 'Archived' : 'Back in use',
        body: archived
          ? `${party.name} takes nothing new. Everything already posted stays exactly as it is.`
          : `${party.name} can be used again.`,
      })
      void load()
    },
    [load, show],
  )

  const searchBox = useSearchShortcut(
    `parties.search-${role ?? 'party'}`,
    'Parties',
    `Search these ${copy.title.toLowerCase()}`,
  )

  const rows = useMemo(() => filterParties(parties ?? [], query), [parties, query])
  const searched = query.trim()

  return (
    <ScreenFrame
      isInset
      width="list"
      title={copy.title}
      lede={copy.lede}
      actions={
        <Button icon="plus" variant="primary" onClick={() => setEditing('new')}>
          {copy.newLabel}
        </Button>
      }
    >
      <div className="stack">
        {error && <FailureNotice error={error} context="ledger" />}

        <ListToolbar
          placeholder="Search by name, registration number or city"
          query={query}
          onQueryChange={setQuery}
          includeArchived={includeArchived}
          onIncludeArchivedChange={setIncludeArchived}
          inputRef={searchBox}
        />

        {parties === null ? (
          error === null && <RegisterSkeleton label={copy.title.toLowerCase()} columns={COLUMNS} />
        ) : rows.length === 0 ? (
          <RegisterEmpty
            plural={copy.title.toLowerCase()}
            isFiltered={searched !== ''}
            sentence={copy.emptyBody}
            newLabel={`Add the first ${copy.noun}`}
            onNew={() => setEditing('new')}
            filteredSentence={`No ${copy.noun} has ${searched} in their name, registration number or city.${archivedNote(includeArchived)}`}
            clearLabel="Clear the search"
            onClear={() => setQuery('')}
          />
        ) : (
          <div className="register">
            <table className="ledger-table register__table">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Registration</th>
                  <th scope="col">City</th>
                  <th scope="col">Kind</th>
                  <th scope="col">
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((party) => (
                  <tr
                    key={party.id}
                    className={`ledger-table__row${party.isArchived ? ' ledger-table__row--archived' : ''}`}
                  >
                    <td className="register__name">
                      <Button variant="ghost" size="sm" onClick={() => void openEditor(party.id)}>
                        {party.name}
                      </Button>
                      {party.isArchived && (
                        <>
                          {' '}
                          <Badge tone="neutral">Archived</Badge>
                        </>
                      )}
                    </td>
                    {/* An unregistered party is ordinary — a dash, not a gap that reads
                        as a field somebody forgot to fill in. */}
                    <td className="ledger-table__code">{party.registrationNumber ?? '—'}</td>
                    <td className="ledger-table__muted">{party.city ?? '—'}</td>
                    <td className="ledger-table__muted">{partyKindLabel(party)}</td>
                    <td className="register__actions">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void setArchived(party, !party.isArchived)}
                      >
                        {party.isArchived ? 'Restore' : 'Archive'}
                      </Button>{' '}
                      <Button variant="ghost" size="sm" onClick={() => setDeleting(party)}>
                        Delete
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* B25: the header above has always said a party nothing was posted against can be
          deleted, and nothing on the screen could. Main refuses the rest in words. */}
      <DeleteDialog
        key={deleting === null ? 'delete:closed' : `delete:${deleting.id}`}
        name={deleting?.name ?? null}
        sentence="This removes them from these books entirely. It is refused once anything has been raised or posted against them — archive them instead, and everything already in the books stays as it is."
        onConfirm={() =>
          deleting === null
            ? Promise.resolve({ ok: true, data: undefined })
            : callApi((api) => api.parties.delete(deleting.id))
        }
        onClose={() => setDeleting(null)}
        onDeleted={() => {
          const name = deleting?.name ?? ''
          setDeleting(null)
          show({
            tone: 'success',
            title: 'Deleted',
            body: `${name} is gone. Nothing was posted against them.`,
          })
          void load()
        }}
      />

      {/*
       * MOUNTED WHEN IT OPENS, and that is what makes the country default reliable: the
       * draft is seeded once, from whatever the profile has said by then, rather than
       * from whatever it had said when the screen first drew.
       */}
      {editing !== null && (
        <PartyDialog
          key={editing === 'new' ? 'new' : editing.id}
          role={role}
          party={editing === 'new' ? null : editing}
          homeCountryCode={homeCountryCode}
          jurisdictions={regime?.jurisdictions ?? []}
          onClose={() => setEditing(null)}
          onSaved={(saved, wasNew) => {
            setEditing(null)
            show({
              tone: 'success',
              title: wasNew ? 'Added' : 'Saved',
              body: leavesList(role, saved)
                ? `${saved.name} is no longer a ${copy.noun}, so they have left this list. They are still in the books.`
                : `${saved.name} is up to date.`,
            })
            void load()
          }}
        />
      )}
    </ScreenFrame>
  )
}

// ---- Adding and editing ----------------------------------------------------

/**
 * One band of the form, with a heading somebody can skip past.
 *
 * A heading rather than a `<fieldset>`: the legend's own box would need a stylesheet this
 * batch does not own, and `aria-labelledby` on a section names the group for assistive
 * technology just as a legend does. The heading is an `h3` because the dialog's title is
 * the `h2` above it.
 */
function FieldGroup({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  const headingId = useId()
  return (
    <section className="stack stack--tight" aria-labelledby={headingId}>
      <h3 id={headingId} className="caps-label">
        {title}
      </h3>
      {children}
    </section>
  )
}

interface PartyDialogProps {
  role: PartyRole | null
  /** Null when adding. */
  party: Party | null
  /** The company's own country. Where a new party starts. */
  homeCountryCode: string
  /** What `regime.describe()` listed. Empty where the regime has no sub-national codes. */
  jurisdictions: readonly JurisdictionOption[]
  onClose: () => void
  onSaved: (party: Party, wasNew: boolean) => void
}

/**
 * One dialog for adding and for editing.
 *
 * The fields are identical and the rules are identical; two dialogs would be two places
 * to forget the same thing. What differs is the verb and whether an id is sent.
 *
 * THE REGISTRATION NUMBER IS NOT CHECKED HERE. Whether `33AABCC1234D1ZI` is a real GSTIN
 * is the regime's question, asked in the main process, and its answer is a sentence
 * written for the user. A second, weaker check in the renderer would either disagree with
 * it or repeat it, and this is the layer that must not compute anything about tax.
 *
 * NOR IS THE STATE RECONCILED WITH IT. A GSTIN encodes a state code and the state decides
 * the tax, so a number and a state that disagree are two different answers to the
 * question the money turns on. `books/registration.ts` settles that, once, for the party
 * and for the company alike: THE NUMBER WINS — where the picker is left at "Not set" the
 * state is filled in from the number, and where the two contradict each other the save is
 * REFUSED rather than reconciled, because picking one silently is wrong half the time and
 * invisible either way. The screen's whole part in this is to say so in the hint, to send
 * both fields exactly as they were given, and to show main's sentence with the form still
 * filled in. The renderer does not know that an Indian registration number encodes a
 * state and must not learn.
 *
 * WHAT THE SCREEN DOES OWN is the box of text. `parsePaymentTerms` turns one into a whole
 * number of days or says why it cannot, which is a form's job and not a rule the service
 * has an opinion about; `creditLimit` crosses as typed, because the renderer never
 * computes money and main is what parses, scales and refuses it.
 */
function PartyDialog({
  role,
  party,
  homeCountryCode,
  jurisdictions,
  onClose,
  onSaved,
}: PartyDialogProps): JSX.Element {
  const isNew = party === null

  const [draft, setDraft] = useState<PartyDraft>(() =>
    party === null ? blankDraft(role, homeCountryCode) : draftOf(party),
  )
  const [isBusy, setBusy] = useState(false)
  const [error, setError] = useState<AppError | null>(null)

  const set = useCallback(
    <K extends keyof PartyDraft>(field: K, value: PartyDraft[K]) =>
      setDraft((current) => ({ ...current, [field]: value })),
    [],
  )

  const hasTyped = useHasTyped(draft)
  const terms = parsePaymentTerms(draft.paymentTermsDays)
  const hasARole = draft.isCustomer || draft.isVendor
  const canSubmit =
    draft.name.trim() !== '' && hasARole && draft.countryCode.trim() !== '' && terms.ok && !isBusy

  const submit = useCallback(async () => {
    /* Re-parsed rather than closed over, so the payload and the button are reading the
     * same draft — a stale `terms` would be a save going out on the previous keystroke. */
    const parsed = parsePaymentTerms(draft.paymentTermsDays)
    if (!parsed.ok) return
    if (draft.name.trim() === '' || !(draft.isCustomer || draft.isVendor)) return
    if (draft.countryCode.trim() === '' || isBusy) return

    setBusy(true)
    setError(null)

    const fields = partyFieldsFrom(draft, parsed.days)
    const result = await callApi((api) =>
      isNew ? api.parties.create(fields) : api.parties.update({ ...fields, id: party.id }),
    )
    setBusy(false)

    if (!result.ok) {
      setError(result.error)
      return
    }
    onSaved(result.data, isNew)
  }, [draft, isBusy, isNew, onSaved, party])

  return (
    <Dialog
      isOpen
      onClose={onClose}
      hasUnsavedInput={hasTyped}
      title={isNew ? copyFor(role).newLabel : 'Edit'}
      description="One record per firm. Tick both boxes when you buy from someone you also sell to — that is what keeps their balance in one place."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={() => void submit()}
            disabled={!canSubmit}
            isBusy={isBusy}
          >
            {isNew ? 'Add' : 'Save'}
          </Button>
        </>
      }
    >
      <div className="stack">
        {error && <FailureNotice error={error} context="ledger" />}

        <FieldGroup title="Who they are">
          <Input
            label="Name"
            value={draft.name}
            onChange={(event) => set('name', event.target.value)}
            hint="Two firms may share a name — add the city or an initial so an invoice cannot be raised against the wrong one."
          />

          <Input
            label="Legal name"
            value={draft.legalName}
            onChange={(event) => set('legalName', event.target.value)}
            hint="Only if they are registered under a different name from the one you call them by. That is the one an invoice has to carry."
          />

          <CheckboxField
            isChecked={draft.isCustomer}
            onChange={(value) => set('isCustomer', value)}
          >
            We sell to them — makes them available on an invoice
          </CheckboxField>
          <CheckboxField isChecked={draft.isVendor} onChange={(value) => set('isVendor', value)}>
            We buy from them — makes them available on a bill
          </CheckboxField>

          {!hasARole && (
            <Notice tone="warning" title="Which way does the money go?">
              <p>
                A record has to be one or the other, or both. Tick at least one box — nothing can be
                raised against a firm that is neither.
              </p>
            </Notice>
          )}
        </FieldGroup>

        <FieldGroup title="Registration and place of supply">
          <Input
            label="Registration number"
            isIdentifier
            value={draft.registrationNumber}
            onChange={(event) => set('registrationNumber', event.target.value)}
            hint="GSTIN, if they have one. Its first two digits say which state they are in, and that decides the tax on every invoice."
          />

          {/*
           * A plain picker over what the regime listed, exactly as the company's own
           * screen has. The hint is said in words rather than enforced in code: main
           * fills this in from the registration number where the number encodes one, and
           * refuses a pair that disagree. The renderer does not know which numbers encode
           * what — see the note above the component.
           */}
          <Select
            label="State or region"
            value={draft.jurisdictionCode}
            onChange={(event) => set('jurisdictionCode', event.target.value)}
            hint="Where they are. This decides the place of supply, and the place of supply decides the tax. Filled in from the registration number when there is one, which is the answer that wins if the two disagree."
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
            hint="Starts as the country in your business details — change it for somebody you export to."
          />

          {isPlaceOfSupplyUnknown(draft, homeCountryCode) && (
            <Notice tone="warning" title="Nothing here says where they are">
              <p>
                With no registration number and no state, there is nothing to work a place of supply
                out from, and every document raised against them is treated as crossing a state
                line. Pick the state even when they are not registered — most small customers are
                not.
              </p>
            </Notice>
          )}
        </FieldGroup>

        <FieldGroup title="Terms">
          <Input
            label="Payment terms (days)"
            inputMode="numeric"
            value={draft.paymentTermsDays}
            onChange={(event) => set('paymentTermsDays', event.target.value)}
            hint="Days from the document's date to the day it falls due — 30 for net 30. Blank means nothing was agreed. A document takes a copy of this when it is issued and keeps it, so changing it here re-ages nothing already raised."
            error={terms.ok ? undefined : terms.message}
          />

          <Input
            label="Credit limit"
            value={draft.creditLimit}
            onChange={(event) => set('creditLimit', event.target.value)}
            hint="Blank means no limit. Nought is not the same answer — that is a limit of nothing, which is how a business says this one pays up front."
          />
        </FieldGroup>

        {/* No sample values as placeholders (B13, which named the business details and is the
            same mistake here): on an empty form "14 Anna Salai" reads as an address already
            entered. */}
        <FieldGroup title="Address and contact">
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
            hint="On the list, because it is what tells two firms of the same name apart."
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
        </FieldGroup>

        {/*
         * `Anything else` and not `Notes`, which is what it read first. A band's heading
         * names the band through `aria-labelledby`, so a heading spelt exactly like a
         * field inside it gives two elements the same accessible name — and
         * `getByLabelText('Notes')` then finds the section as well as the box. Renaming
         * the band is the fix; dropping the name off the section would take the grouping
         * away from a screen reader to make a query tidier.
         */}
        <FieldGroup title="Anything else">
          <Input
            label="Notes"
            value={draft.notes}
            onChange={(event) => set('notes', event.target.value)}
            hint="Anything whoever opens this record next needs to know. Not printed on anything."
          />
        </FieldGroup>
      </div>
    </Dialog>
  )
}

/*
 * After the documents and receipts on their side, and before its aged report. The rail is
 * ordered as a day's work goes: what you raise, what you are paid, then who with.
 */
const PARTIES_NAV_ORDER = 20

registerScreens([
  {
    id: 'customers',
    title: 'Customers',
    area: 'workspace',
    nav: { label: 'Customers', icon: 'people', group: 'sales', order: PARTIES_NAV_ORDER },
    render: ({ route }) => <Parties role="customer" openId={route.params['id']} />,
  },
  {
    id: 'vendors',
    title: 'Vendors',
    area: 'workspace',
    nav: { label: 'Vendors', icon: 'truck', group: 'purchases', order: PARTIES_NAV_ORDER },
    render: ({ route }) => <Parties role="vendor" openId={route.params['id']} />,
  },
  /*
   * Not in the rail, and reachable from the palette. Two entries for two words the
   * business uses is the point; a third called `Parties` beside them would be a
   * different name for the same list, which is precisely the confusion the single table
   * exists to avoid. It is registered because the unfiltered list is the right answer
   * when somebody is looking for a firm and cannot remember which side they are on.
   */
  {
    id: 'parties',
    title: 'Parties',
    area: 'workspace',
    render: () => <Parties />,
  },
])
