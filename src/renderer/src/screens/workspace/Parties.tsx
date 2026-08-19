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
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { JSX } from 'react'
import { Badge, Button, Dialog, Input } from '@renderer/components/atoms'
import { callApi } from '@renderer/lib/api'
import type { Command } from '@renderer/lib/command-registry'
import { registerScreens } from '@renderer/lib/screens'
import { useRegisterCommands } from '@renderer/store/commands'
import { useToasts } from '@renderer/store/toasts'
import type { AppError, Party, PartyRole, PartySummary } from '@shared/dto'
import { CheckboxField } from '../components/CheckboxField'
import { FailureNotice } from '../components/FailureNotice'
import { Notice } from '../components/Notice'
import { ScreenFrame } from '../components/ScreenFrame'
import { copyFor, filterParties, leavesList, partyKindLabel } from '../lib/party-view'

interface PartiesProps {
  /** Which side this screen was entered from. Null lists everybody. */
  role?: PartyRole | null
}

export function Parties({ role = null }: PartiesProps): JSX.Element {
  const { show } = useToasts()
  const copy = useMemo(() => copyFor(role), [role])

  const [parties, setParties] = useState<PartySummary[] | null>(null)
  const [error, setError] = useState<AppError | null>(null)
  const [query, setQuery] = useState('')
  const [includeArchived, setIncludeArchived] = useState(false)
  const [editing, setEditing] = useState<Party | 'new' | null>(null)

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

  useRegisterCommands(
    useMemo<Command[]>(
      () => [
        {
          id: `parties.new-${role ?? 'party'}`,
          title: copy.newLabel,
          section: 'Parties',
          keywords: ['customer', 'vendor', 'party', 'create'],
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

  const rows = useMemo(() => filterParties(parties ?? [], query), [parties, query])

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

        <div className="toolbar">
          <Input
            label="Search"
            isLabelHidden
            icon="search"
            placeholder="Search by name, registration number or city"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <label className="toolbar__toggle">
            <input
              type="checkbox"
              checked={includeArchived}
              onChange={(event) => setIncludeArchived(event.target.checked)}
            />
            Show archived
          </label>
        </div>

        {parties === null ? (
          <p className="prose prose--muted">Reading the list…</p>
        ) : rows.length === 0 ? (
          <Notice
            tone="info"
            title={query.trim() === '' ? copy.emptyTitle : 'Nothing matches that'}
          >
            <p>
              {query.trim() === ''
                ? copy.emptyBody
                : `No ${copy.noun} has ${query.trim()} in their name, registration number or city.`}
              {!includeArchived && ' Archived records are hidden — turn them on to include them.'}
            </p>
          </Notice>
        ) : (
          <table className="ledger-table">
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
                  <td>
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
                  <td>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void setArchived(party, !party.isArchived)}
                    >
                      {party.isArchived ? 'Restore' : 'Archive'}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <PartyDialog
        key={editing === null ? 'closed' : editing === 'new' ? 'new' : editing.id}
        isOpen={editing !== null}
        role={role}
        party={editing === 'new' ? null : editing}
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
    </ScreenFrame>
  )
}

// ---- Adding and editing ----------------------------------------------------

interface PartyDialogProps {
  isOpen: boolean
  role: PartyRole | null
  /** Null when adding. */
  party: Party | null
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
 */
function PartyDialog({ isOpen, role, party, onClose, onSaved }: PartyDialogProps): JSX.Element {
  const isNew = party === null

  const [name, setName] = useState(party?.name ?? '')
  const [registrationNumber, setRegistrationNumber] = useState(party?.registrationNumber ?? '')
  const [city, setCity] = useState(party?.city ?? '')
  const [email, setEmail] = useState(party?.email ?? '')
  const [phone, setPhone] = useState(party?.phone ?? '')
  /* A new record defaults to the side the screen was opened from, and to a customer on
   * the unfiltered one. A party that is neither is refused, and defaulting to neither
   * would make the first save fail for everybody. */
  const [isCustomer, setCustomer] = useState(party?.isCustomer ?? role !== 'vendor')
  const [isVendor, setVendor] = useState(party?.isVendor ?? role === 'vendor')

  const [isBusy, setBusy] = useState(false)
  const [error, setError] = useState<AppError | null>(null)

  const hasARole = isCustomer || isVendor
  const canSubmit = name.trim() !== '' && hasARole && !isBusy

  const submit = useCallback(async () => {
    if (!canSubmit) return
    setBusy(true)
    setError(null)

    const fields = {
      name: name.trim(),
      isCustomer,
      isVendor,
      /* Blank means "none", and the main process reads it that way — an empty box is a
       * user saying they have no GSTIN, not a user typing an invalid one. */
      registrationNumber: registrationNumber.trim(),
      city: city.trim(),
      email: email.trim(),
      phone: phone.trim(),
    }

    const result = await callApi((api) =>
      isNew
        ? api.parties.create({ ...fields, countryCode: 'in' })
        : api.parties.update({ ...fields, id: party.id }),
    )
    setBusy(false)

    if (!result.ok) {
      setError(result.error)
      return
    }
    onSaved(result.data, isNew)
  }, [
    canSubmit,
    city,
    email,
    isCustomer,
    isNew,
    isVendor,
    name,
    onSaved,
    party,
    phone,
    registrationNumber,
  ])

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
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

        <Input
          label="Name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          hint="Two firms may share a name — add the city or an initial so an invoice cannot be raised against the wrong one."
        />

        <Input
          label="Registration number"
          value={registrationNumber}
          onChange={(event) => setRegistrationNumber(event.target.value)}
          hint="GSTIN, if they have one. Its first two digits say which state they are in, and that decides the tax on every invoice."
        />

        <Input label="City" value={city} onChange={(event) => setCity(event.target.value)} />
        <Input
          label="Email"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <Input label="Phone" value={phone} onChange={(event) => setPhone(event.target.value)} />

        <CheckboxField isChecked={isCustomer} onChange={setCustomer}>
          We sell to them — makes them available on an invoice
        </CheckboxField>
        <CheckboxField isChecked={isVendor} onChange={setVendor}>
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
      </div>
    </Dialog>
  )
}

registerScreens([
  {
    id: 'customers',
    title: 'Customers',
    area: 'workspace',
    nav: { label: 'Customers', icon: 'people', group: 'sales', order: 0 },
    render: () => <Parties role="customer" />,
  },
  {
    id: 'vendors',
    title: 'Vendors',
    area: 'workspace',
    nav: { label: 'Vendors', icon: 'truck', group: 'purchases', order: 0 },
    render: () => <Parties role="vendor" />,
  },
  /*
   * Not in the sidebar, and reachable from the palette. Two entries for two words the
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
