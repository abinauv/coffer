/*
 * One voucher: recording it, saying what it settles, and cancelling it. Both directions,
 * one component.
 *
 * WAS `Receipt.tsx`, WITH THE KIND FIXED. A payment posted perfectly well from 0012 and
 * had nothing to settle until a purchase bill could be issued, which 0013-1 made
 * possible. A payment differs from a receipt in whose money it is, which way it moved,
 * and which documents its picker lists — and in nothing else on this screen.
 *
 * TWO SCREENS IN ONE COMPONENT, AND THE SPLIT IS RULE 1. A receipt records money that has
 * already moved, so it posts the moment it is recorded — there is no draft. Before it
 * exists, everything about it is editable and there is one button. After it exists, the
 * party, the date, the amount and the account are FROZEN, exactly as an issued invoice
 * is, and the only thing left to change is what it settles.
 *
 * That is not an inconsistency in the freeze. An allocation moves no money and writes no
 * entry (rule 2) — it says which invoices this money pays, and a business changes its
 * mind about that without anything in the ledger being wrong. Correcting the money itself
 * is a cancel, which reverses the entry and keeps the number.
 *
 * THE FIGURES ARE MAIN'S, AS EVERYWHERE. The screen does not add up the allocations the
 * user has typed to show what is left of the receipt — that is money arithmetic
 * (CONVENTIONS §1.7). What it does instead is what the invoice editor does: save, and
 * show what came back, marked as belonging to the last saved version while there are
 * unsaved edits.
 *
 * WHAT REPLACES THE ARITHMETIC IS `outstanding`, WHICH MAIN ALREADY SENT. Every open
 * invoice arrives carrying what is left on it, so "Settle in full" COPIES that figure
 * into the box rather than working one out. Exact by construction, and it is the action a
 * user takes nine times in ten.
 *
 * OPENED FROM A DOCUMENT, IT ARRIVES PRE-FILLED. `partyId` and `documentId` in the route
 * are what "Record a receipt" on an invoice — or "Record a payment" on a bill — sends.
 * The amount is deliberately NOT pre-filled from the document: what moved is a fact about
 * a bank statement, and a screen that guessed it would have somebody confirming a figure
 * they had not read.
 *
 * THE LAYOUT IS THE DOCUMENT EDITOR'S SINCE 5b: the status and the verbs in the header,
 * the fields in one grid, what it settles in a card, and main's figures pinned in a panel
 * headed "last saved". The rail marks the register while this is open, so there is no
 * separate way back drawn on the page.
 */

import { useCallback, useEffect, useState } from 'react'
import type { JSX } from 'react'
import { Badge, Button, Input, Select } from '@renderer/components/atoms'
import { callApi } from '@renderer/lib/api'
import { makeRoute } from '@renderer/lib/routing'
import { registerScreens, type ScreenContext, type ScreenDefinition } from '@renderer/lib/screens'
import { useNumberFormat } from '@renderer/store/regime'
import { useToasts } from '@renderer/store/toasts'
import type {
  Account,
  AppError,
  OpenDocument,
  PartySummary,
  Receipt as ReceiptDto,
} from '@shared/dto'
import { RECEIPT_KINDS, receiptDefinitionOf, type ReceiptKind } from '@shared/receipts'
import { FailureNotice } from '../components/FailureNotice'
import { MoneyField } from '../components/MoneyField'
import { Notice } from '../components/Notice'
import { ScreenFrame } from '../components/ScreenFrame'
import { formatDate } from '../lib/dates'
import { formatAmount } from '../lib/ledger-format'
import {
  accountHint,
  accountLabel,
  amountHint,
  canAllocate,
  canCancel,
  draftAllocations,
  isStruckStatus,
  newSentence,
  partyLabel,
  partyRoleFor,
  registerScreenId,
  settleInFull,
  settlesLabel,
  stateSentence,
  statusLabel,
  statusTone,
  toAllocationInputs,
} from '../lib/receipt-view'

export function ReceiptEditor({
  kind,
  route,
  navigate,
}: ScreenContext & { kind: ReceiptKind }): JSX.Element {
  const receiptId = route.params['id'] ?? null
  const { show } = useToasts()
  const format = useNumberFormat()

  const definition = receiptDefinitionOf(kind)
  const label = definition.label.toLowerCase()
  const party = partyLabel(definition.side)
  /* What this settles, plural and lower case, for the sentences that name it. Read off
   * the DOCUMENT table so a payment says "purchase bills" — see `settlesLabel`. */
  const settled = `${settlesLabel(kind).toLowerCase()}s`

  const [receipt, setReceipt] = useState<ReceiptDto | null>(null)
  const [parties, setParties] = useState<PartySummary[]>([])
  const [accounts, setAccounts] = useState<Account[]>([])
  const [open, setOpen] = useState<OpenDocument[]>([])
  const [error, setError] = useState<AppError | null>(null)
  const [isBusy, setBusy] = useState(false)
  const [isReading, setReading] = useState(receiptId !== null)

  const [partyId, setPartyId] = useState(route.params['partyId'] ?? '')
  const [date, setDate] = useState('')
  const [amount, setAmount] = useState('')
  const [accountId, setAccountId] = useState('')
  const [reference, setReference] = useState('')
  const [narration, setNarration] = useState('')

  /* Keyed by document, because a receipt cannot allocate to one invoice twice (0012's
   * UNIQUE): the picker's rows ARE the documents, and there is nothing to add or remove. */
  const [allocations, setAllocations] = useState<Record<string, string>>({})
  const [isDirty, setDirty] = useState(false)

  /** Take main's answer as the truth, and clear the unsaved-edits mark. */
  const adopt = useCallback((next: ReceiptDto): void => {
    setReceipt(next)
    setPartyId(next.partyId)
    setDate(next.date)
    setAmount(next.amount)
    setAccountId(next.accountId)
    setReference(next.reference)
    setNarration(next.narration)
    setDirty(false)
    setError(null)
  }, [])

  const load = useCallback(async () => {
    const [people, chart] = await Promise.all([
      callApi((api) => api.parties.list({ role: partyRoleFor(definition.side) })),
      callApi((api) => api.ledger.listAccounts()),
    ])
    if (people.ok) setParties(people.data)
    if (chart.ok) setAccounts(chart.data.filter((row) => !row.isGroup && !row.isArchived))

    if (receiptId === null) {
      setReading(false)
      return
    }

    const result = await callApi((api) => api.receipts.get(receiptId))
    setReading(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    if (result.data === null) {
      setError({
        code: 'RECEIPT_NOT_FOUND',
        message: `That ${label} is no longer in these books.`,
      })
      return
    }
    /*
     * THE HAZARD ONE EDITOR FOR TWO KINDS CREATES, and the same one the document editor
     * carries: the kind comes from the route and so does the id, independently. A stale
     * link can load a receipt into the payment editor, where the party picker would list
     * vendors, the allocation table would head itself Purchase bill, and the figures
     * would be a customer's. Nothing would look wrong.
     */
    if (result.data.kind !== kind) {
      setError({
        code: 'RECEIPT_KIND_MISMATCH',
        message: `That voucher is not a ${label}. Open it from its own register.`,
      })
      return
    }
    adopt(result.data)
  }, [adopt, definition.side, kind, label, receiptId])

  useEffect(() => {
    void load()
  }, [load])

  /*
   * The open invoices for whoever is chosen, re-read whenever the customer changes.
   *
   * `exceptReceiptId` matters and is easy to miss: an existing receipt's own allocations
   * have to come back as available, or the invoice this screen is showing a line for is
   * simply absent from the list and the user cannot reduce what they allocated.
   */
  useEffect(() => {
    let current = true

    async function readOpen(): Promise<void> {
      if (partyId === '') {
        setOpen([])
        setAllocations({})
        return
      }
      const result = await callApi((api) =>
        api.receipts.open({
          partyId,
          kind,
          ...(receipt === null ? {} : { exceptReceiptId: receipt.id }),
        }),
      )
      if (!current) return
      if (!result.ok) {
        setError(result.error)
        return
      }
      setOpen(result.data)
      setAllocations(
        draftAllocations(result.data, receipt?.allocations ?? preselected(route.params)),
      )
    }

    void readOpen()
    return () => {
      current = false
    }
  }, [kind, partyId, receipt, route.params])

  const touch = useCallback((change: () => void) => {
    setDirty(true)
    change()
  }, [])

  const setAllocation = useCallback(
    (documentId: string, value: string) =>
      touch(() => setAllocations((current) => ({ ...current, [documentId]: value }))),
    [touch],
  )

  const status = receipt?.status ?? 'posted'
  const isNew = receipt === null
  const canRecord =
    isNew && partyId !== '' && date !== '' && amount.trim() !== '' && accountId !== ''

  const record = useCallback(async () => {
    if (!canRecord) return
    setBusy(true)
    setError(null)

    const result = await callApi((api) =>
      api.receipts.create({
        kind,
        date,
        partyId,
        amount: amount.trim(),
        accountId,
        reference: reference.trim(),
        narration: narration.trim(),
        allocations: toAllocationInputs(allocations),
      }),
    )
    setBusy(false)
    if (!result.ok) {
      setError(result.error)
      return
    }

    adopt(result.data)
    navigate(makeRoute('workspace', kind, { id: result.data.id }))
    show({
      tone: 'success',
      title: 'Recorded',
      body: `${result.data.number} is in the books. What it settles can still be changed.`,
    })
  }, [
    accountId,
    adopt,
    allocations,
    amount,
    canRecord,
    date,
    kind,
    narration,
    navigate,
    partyId,
    reference,
    show,
  ])

  const saveAllocations = useCallback(async () => {
    if (receipt === null) return
    setBusy(true)
    setError(null)
    const result = await callApi((api) =>
      api.receipts.allocate({ id: receipt.id, allocations: toAllocationInputs(allocations) }),
    )
    setBusy(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    adopt(result.data)
    show({
      tone: 'success',
      title: 'Saved',
      body: `Nothing moved in the ledger — this only says which ${settled} the money pays.`,
    })
  }, [adopt, allocations, receipt, settled, show])

  const cancel = useCallback(async () => {
    if (receipt === null) return
    setBusy(true)
    setError(null)
    const result = await callApi((api) => api.receipts.cancel({ id: receipt.id }))
    setBusy(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    adopt(result.data)
    show({
      tone: 'success',
      title: 'Cancelled',
      body: `The entry is reversed and the ${settled} it settled are owed again. The number is kept.`,
    })
  }, [adopt, receipt, settled, show])

  if (isReading) {
    return (
      <ScreenFrame isInset width="list" title={definition.label}>
        <p className="prose prose--muted">Reading the {label}…</p>
      </ScreenFrame>
    )
  }

  return (
    <ScreenFrame
      isInset
      width="list"
      title={receipt?.number ?? definition.label}
      lede={
        <span className="editor__state">
          {receipt !== null && (
            <Badge tone={statusTone(status)} isStruck={isStruckStatus(status)}>
              {statusLabel(status)}
            </Badge>
          )}
          <span>
            {receipt === null ? newSentence(kind) : stateSentence(status, receipt.number)}
          </span>
        </span>
      }
      actions={
        <>
          {isNew && (
            <Button variant="primary" disabled={!canRecord || isBusy} onClick={() => void record()}>
              Record {label}
            </Button>
          )}
          {receipt !== null && canAllocate(status) && (
            <Button
              variant="primary"
              disabled={isBusy || !isDirty}
              onClick={() => void saveAllocations()}
            >
              Save what it settles
            </Button>
          )}
          {receipt !== null && canCancel(status) && (
            <Button variant="ghost" disabled={isBusy} onClick={() => void cancel()}>
              Cancel this {label}
            </Button>
          )}
        </>
      }
    >
      <div className="stack editor">
        {error && <FailureNotice error={error} context="ledger" />}

        {/*
         * Said once, where it is relevant. A user who has just recorded money and sees
         * the fields go grey needs to know that is the design and not a failure.
         */}
        {receipt !== null && (
          <Notice tone="info" title="The money is recorded and cannot be edited">
            <p>
              A {label} is a statement about money that has already moved, so it is frozen the
              moment it is recorded — the same rule an issued document follows. Correct one by
              cancelling it, which reverses the entry and keeps the number. What it settles is not
              part of that and can still be changed.
            </p>
          </Notice>
        )}

        <div className="editor__fields">
          <Select
            label={party}
            value={partyId}
            disabled={!isNew}
            className="editor__party"
            hint={
              isNew ? `Whose money this is. It decides which ${settled} it can settle.` : undefined
            }
            onChange={(event) => setPartyId(event.target.value)}
          >
            <option value="">Choose a {party.toLowerCase()}</option>
            {parties.map((party) => (
              <option key={party.id} value={party.id}>
                {party.name}
              </option>
            ))}
          </Select>

          <Input
            label="Date"
            type="date"
            value={date}
            disabled={!isNew}
            hint={isNew ? 'When the money moved. It is also the date this posts as of.' : undefined}
            onChange={(event) => setDate(event.target.value)}
          />

          <MoneyField
            label="Amount"
            value={amount}
            disabled={!isNew}
            placeholder="0.00"
            hint={isNew ? amountHint(kind) : undefined}
            onChange={(event) => setAmount(event.target.value)}
          />

          {/*
           * EVERY POSTABLE ACCOUNT, not a filtered list of "money accounts". The role map
           * holds one bank and one cash, and a business with four bank accounts posts to
           * three that fill no role at all — so a renderer that filtered would be
           * inventing a rule main does not have. What main actually refuses is a group, an
           * archived account, and the control account this settles against.
           */}
          <Select
            label={accountLabel(kind)}
            value={accountId}
            disabled={!isNew}
            hint={isNew ? accountHint(kind) : undefined}
            onChange={(event) => setAccountId(event.target.value)}
          >
            <option value="">Choose an account</option>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.code} — {account.name}
              </option>
            ))}
          </Select>

          <Input
            label="Reference"
            value={reference}
            disabled={!isNew}
            isIdentifier
            hint={
              isNew
                ? 'The cheque number or the UTR — whatever identifies it on a statement.'
                : undefined
            }
            onChange={(event) => setReference(event.target.value)}
          />

          <Input
            label="Narration"
            value={narration}
            disabled={!isNew}
            hint={isNew ? 'What the day book will say about the entry this posts.' : undefined}
            onChange={(event) => setNarration(event.target.value)}
          />
        </div>

        <div className="editor__foot">
          <Allocations
            open={open}
            kind={kind}
            values={allocations}
            format={format}
            isEditable={isNew || canAllocate(status)}
            hasParty={partyId !== ''}
            onChange={setAllocation}
          />

          {receipt !== null && (
            <Settled receipt={receipt} settles={settled} isStale={isDirty} format={format} />
          )}
        </div>
      </div>
    </ScreenFrame>
  )
}

/** What "Record a receipt" on an invoice sent, as an allocation to seed. */
function preselected(
  params: Readonly<Record<string, string>>,
): { documentId: string; amount: string }[] {
  const documentId = params['documentId']
  /*
   * Seeded with a BLANK amount rather than the invoice's outstanding. The user has come
   * here holding a bank statement; pre-filling what they owe would invite confirming a
   * figure nobody read, and "Settle in full" is one click away when the two do agree.
   */
  return documentId === undefined ? [] : [{ documentId, amount: '' }]
}

// ---- What it settles --------------------------------------------------------

function Allocations({
  open,
  kind,
  values,
  format,
  isEditable,
  hasParty,
  onChange,
}: {
  open: readonly OpenDocument[]
  kind: ReceiptKind
  values: Readonly<Record<string, string>>
  format: Parameters<typeof formatAmount>[1]
  isEditable: boolean
  hasParty: boolean
  onChange: (documentId: string, value: string) => void
}): JSX.Element {
  /* Read off the document table rather than written out here — see `settlesLabel`. A
   * payment settles bills, and calling one an invoice on this screen would be the first
   * place a user learned the wrong word for their own paperwork. THE KIND AND NOT THE
   * SIDE, since 0015: a refund is sales-side and settles credit notes. */
  const settles = settlesLabel(kind)
  const party = partyLabel(receiptDefinitionOf(kind).side).toLowerCase()

  if (!hasParty) {
    return (
      <Notice tone="info" title={`Choose a ${party} to see what is owed`}>
        <p>
          Their open {settles.toLowerCase()}s appear here, oldest first, with what is left on each.
        </p>
      </Notice>
    )
  }

  if (open.length === 0) {
    return (
      <Notice tone="info" title="Nothing of theirs is outstanding">
        <p>
          Record the money anyway — it sits on account until a {settles.toLowerCase()} it can settle
          exists. That is an ordinary thing for a business to hold, not an unfinished job.
        </p>
      </Notice>
    )
  }

  return (
    <div className="register">
      <table className="ledger-table ledger-table--figures register__table">
        <thead>
          <tr>
            <th scope="col">{settles}</th>
            <th scope="col">Date</th>
            <th scope="col" className="ledger-table__figure">
              Total
            </th>
            <th scope="col" className="ledger-table__figure">
              Outstanding
            </th>
            <th scope="col" className="ledger-table__figure">
              Settle
            </th>
            <th scope="col">
              <span className="visually-hidden">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {open.map((document) => (
            <tr key={document.id} className="ledger-table__row">
              <td className="ledger-table__code">{document.number}</td>
              <td className="ledger-table__code register__date">{formatDate(document.date)}</td>
              <td className="ledger-table__figure">{formatAmount(document.grandTotal, format)}</td>
              <td className="ledger-table__figure">{formatAmount(document.outstanding, format)}</td>
              <td className="ledger-table__figure">
                <Input
                  label={`Settle against ${document.number}`}
                  isLabelHidden
                  value={values[document.id] ?? ''}
                  disabled={!isEditable}
                  placeholder="0.00"
                  onChange={(event) => onChange(document.id, event.target.value)}
                />
              </td>
              <td>
                {/* A COPY of what main sent, never a sum — see `settleInFull`. */}
                {isEditable && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onChange(document.id, settleInFull(document))}
                  >
                    Settle in full
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ---- The foot ---------------------------------------------------------------

function Settled({
  receipt,
  settles,
  isStale,
  format,
}: {
  receipt: ReceiptDto
  settles: string
  isStale: boolean
  format: Parameters<typeof formatAmount>[1]
}): JSX.Element {
  return (
    <section className="totals" aria-label="Totals">
      <p className="totals__title caps-label">What it settles — last saved</p>
      <dl className="totals__rows">
        <div className="totals__row">
          <dt>Received</dt>
          <dd>{formatAmount(receipt.amount, format)}</dd>
        </div>
        <div className="totals__row">
          <dt>Settled against {settles}</dt>
          <dd>{formatAmount(receipt.allocated, format)}</dd>
        </div>
        <div className="totals__row totals__row--total">
          <dt>On account</dt>
          <dd>{formatAmount(receipt.unallocated, format)}</dd>
        </div>
      </dl>

      {/*
       * SAID, NOT HIDDEN. These are main's figures for the version that is stored. The
       * renderer cannot add up the allocations on screen and will not pretend to, so when
       * there are unsaved edits it says which version they belong to.
       */}
      {isStale && (
        <Notice tone="warning" title="These figures are from the last saved version">
          <p>Save to see what it now has left on account.</p>
        </Notice>
      )}
    </section>
  )
}

/*
 * One editor per kind. No `nav` on either: an editor is reached from its register, from a
 * row, or from the document it settles — there is no such thing as "the" payment to land
 * on. The id IS the kind, which is why the invoice screen's route to `workspace/receipt`
 * has resolved since 0012 and still does. `navParent` is the kind's register, so the rail
 * keeps it marked while the editor is open.
 */
export const receiptEditorScreens: readonly ScreenDefinition[] = RECEIPT_KINDS.map(
  (definition) => ({
    id: definition.kind,
    title: definition.label,
    area: 'workspace' as const,
    navParent: registerScreenId(definition.kind),
    render: (context: ScreenContext) => <ReceiptEditor {...context} kind={definition.kind} />,
  }),
)

registerScreens(receiptEditorScreens)
