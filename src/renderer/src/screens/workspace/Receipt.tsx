/*
 * One receipt: recording it, saying what it settles, and cancelling it.
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
 * OPENED FROM AN INVOICE, IT ARRIVES PRE-FILLED. `partyId` and `documentId` in the route
 * are what "Record a receipt" on an invoice sends. The amount is deliberately NOT
 * pre-filled from the invoice: what arrived is a fact about a bank statement, and a
 * screen that guessed it would have somebody confirming a figure they had not read.
 */

import { useCallback, useEffect, useState } from 'react'
import type { JSX } from 'react'
import { Badge, Button, Input, Select } from '@renderer/components/atoms'
import { callApi } from '@renderer/lib/api'
import { makeRoute } from '@renderer/lib/routing'
import { registerScreens, type ScreenContext } from '@renderer/lib/screens'
import { useNumberFormat } from '@renderer/store/regime'
import { useToasts } from '@renderer/store/toasts'
import type {
  Account,
  AppError,
  OpenDocument,
  PartySummary,
  Receipt as ReceiptDto,
} from '@shared/dto'
import { FailureNotice } from '../components/FailureNotice'
import { Notice } from '../components/Notice'
import { ScreenFrame } from '../components/ScreenFrame'
import { formatAmount } from '../lib/ledger-format'
import {
  RECEIPT_KIND,
  canAllocate,
  canCancel,
  draftAllocations,
  settleInFull,
  stateSentence,
  statusLabel,
  statusTone,
  toAllocationInputs,
} from '../lib/receipt-view'

export function Receipt({ route, navigate }: ScreenContext): JSX.Element {
  const receiptId = route.params['id'] ?? null
  const { show } = useToasts()
  const format = useNumberFormat()

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
    const [customers, chart] = await Promise.all([
      callApi((api) => api.parties.list({ role: 'customer' })),
      callApi((api) => api.ledger.listAccounts()),
    ])
    if (customers.ok) setParties(customers.data)
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
      setError({ code: 'RECEIPT_NOT_FOUND', message: 'That receipt is no longer in these books.' })
      return
    }
    adopt(result.data)
  }, [adopt, receiptId])

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
          kind: RECEIPT_KIND,
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
  }, [partyId, receipt, route.params])

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
        kind: RECEIPT_KIND,
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
    navigate(makeRoute('workspace', 'receipt', { id: result.data.id }))
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
      body: 'Nothing moved in the ledger — this only says which invoices the money pays.',
    })
  }, [adopt, allocations, receipt, show])

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
      body: 'The entry is reversed and the invoices it settled are owed again. The number is kept.',
    })
  }, [adopt, receipt, show])

  if (isReading) {
    return (
      <ScreenFrame isInset width="list" title="Receipt">
        <p className="prose prose--muted">Reading the receipt…</p>
      </ScreenFrame>
    )
  }

  return (
    <ScreenFrame
      isInset
      width="list"
      title={receipt?.number ?? 'New receipt'}
      lede={
        receipt === null
          ? 'Money that has already arrived. Recording it posts it — there is no draft.'
          : stateSentence(status, receipt.number)
      }
      actions={
        <>
          <Button variant="ghost" onClick={() => navigate(makeRoute('workspace', 'receipts'))}>
            Back to the register
          </Button>
          {isNew && (
            <Button variant="primary" disabled={!canRecord || isBusy} onClick={() => void record()}>
              Record receipt
            </Button>
          )}
        </>
      }
    >
      <div className="stack">
        {error && <FailureNotice error={error} context="ledger" />}

        {receipt !== null && (
          <div className="toolbar">
            <Badge tone={statusTone(status)}>{statusLabel(status)}</Badge>
            {canAllocate(status) && (
              <Button
                variant="primary"
                disabled={isBusy || !isDirty}
                onClick={() => void saveAllocations()}
              >
                Save what it settles
              </Button>
            )}
            {canCancel(status) && (
              <Button variant="ghost" disabled={isBusy} onClick={() => void cancel()}>
                Cancel this receipt
              </Button>
            )}
          </div>
        )}

        {/*
         * Said once, where it is relevant. A user who has just recorded money and sees
         * the header go grey needs to know that is the design and not a failure.
         */}
        {receipt !== null && (
          <Notice tone="info" title="The money is recorded and cannot be edited">
            <p>
              A receipt is a statement about money that has already moved, so it is frozen the
              moment it is recorded — the same rule an issued invoice follows. Correct one by
              cancelling it, which reverses the entry and keeps the number. What it settles is not
              part of that and can still be changed.
            </p>
          </Notice>
        )}

        <div className="stack">
          <Select
            label="Customer"
            value={partyId}
            disabled={!isNew}
            hint={
              isNew ? 'Whose money this is. It decides which invoices it can settle.' : undefined
            }
            onChange={(event) => setPartyId(event.target.value)}
          >
            <option value="">Choose a customer</option>
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

          <Input
            label="Amount"
            value={amount}
            disabled={!isNew}
            placeholder="0.00"
            hint={
              isNew
                ? 'What arrived. Money going the other way is a payment, not a negative receipt.'
                : undefined
            }
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
            label="Account the money landed in"
            value={accountId}
            disabled={!isNew}
            hint={isNew ? 'The bank or cash account it went into.' : undefined}
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

        <Allocations
          open={open}
          values={allocations}
          format={format}
          isEditable={isNew || canAllocate(status)}
          hasParty={partyId !== ''}
          onChange={setAllocation}
        />

        {receipt !== null && <Settled receipt={receipt} isStale={isDirty} format={format} />}
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
  values,
  format,
  isEditable,
  hasParty,
  onChange,
}: {
  open: readonly OpenDocument[]
  values: Readonly<Record<string, string>>
  format: Parameters<typeof formatAmount>[1]
  isEditable: boolean
  hasParty: boolean
  onChange: (documentId: string, value: string) => void
}): JSX.Element {
  if (!hasParty) {
    return (
      <Notice tone="info" title="Choose a customer to see what they owe">
        <p>Their open invoices appear here, oldest first, with what is left on each.</p>
      </Notice>
    )
  }

  if (open.length === 0) {
    return (
      <Notice tone="info" title="Nothing of theirs is outstanding">
        <p>
          Record the money anyway — it sits on account until an invoice it can settle exists. That
          is an ordinary thing for a business to hold, not an unfinished job.
        </p>
      </Notice>
    )
  }

  return (
    <table className="ledger-table ledger-table--figures">
      <thead>
        <tr>
          <th scope="col">Invoice</th>
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
            <td className="ledger-table__code">{document.date}</td>
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
  )
}

// ---- The foot ---------------------------------------------------------------

function Settled({
  receipt,
  isStale,
  format,
}: {
  receipt: ReceiptDto
  isStale: boolean
  format: Parameters<typeof formatAmount>[1]
}): JSX.Element {
  return (
    <div className="stack stack--tight">
      {/*
       * SAID, NOT HIDDEN. These are main's figures for the version that is stored. The
       * renderer cannot add up the allocations on screen and will not pretend to, so when
       * there are unsaved edits it says which version they belong to.
       */}
      {isStale && (
        <Notice tone="info" title="These figures are from the last saved version">
          <p>Save to see what the receipt now has left on account.</p>
        </Notice>
      )}

      <table className="ledger-table ledger-table--figures">
        <tbody>
          <tr>
            <td>Received</td>
            <td className="ledger-table__figure">{formatAmount(receipt.amount, format)}</td>
          </tr>
          <tr>
            <td>Settled against invoices</td>
            <td className="ledger-table__figure">{formatAmount(receipt.allocated, format)}</td>
          </tr>
          <tr>
            <td>On account</td>
            <td className="ledger-table__figure">{formatAmount(receipt.unallocated, format)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}

registerScreens([
  {
    id: 'receipt',
    title: 'Receipt',
    area: 'workspace',
    /* No `nav`. Reached from the register, from a row, or from an invoice — there is no
     * such thing as "the" receipt to land on. */
    render: (context) => <Receipt {...context} />,
  },
])
