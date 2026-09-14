/*
 * The chart of accounts.
 *
 * A flat list with an indent, not a collapsible tree. `listAccounts` already returns the
 * accounts in tree order carrying their depth, and a chart of forty rows is a thing to
 * read rather than a thing to navigate — collapsing would hide the account somebody is
 * looking for behind a disclosure triangle they have to guess at.
 *
 * NO BALANCES HERE. This is what the accounts *are*; what is in them is the trial
 * balance, one screen along. Putting a figure on every row would mean loading the whole
 * ledger to draw a settings screen, and would invite reading it as a report.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { JSX } from 'react'
import { Badge, Button, Dialog, Input } from '@renderer/components/atoms'
import { callApi } from '@renderer/lib/api'
import type { Command } from '@renderer/lib/command-registry'
import { registerScreens } from '@renderer/lib/screens'
import { useRegisterCommands } from '@renderer/store/commands'
import { useToasts } from '@renderer/store/toasts'
import type { Account, AccountType, AppError } from '@shared/dto'
import { FailureNotice } from '../components/FailureNotice'
import { Notice } from '../components/Notice'
import { ScreenFrame } from '../components/ScreenFrame'
import { accountLabel, filterChart, parentsForType } from '../lib/chart-tree'
import { accountTypeLabel, ACCOUNT_TYPE_ORDER } from '../lib/ledger-format'

export function ChartOfAccounts(): JSX.Element {
  const { show } = useToasts()
  const [accounts, setAccounts] = useState<Account[] | null>(null)
  const [error, setError] = useState<AppError | null>(null)
  const [query, setQuery] = useState('')
  const [includeArchived, setIncludeArchived] = useState(false)
  const [isCreateOpen, setCreateOpen] = useState(false)

  const load = useCallback(async () => {
    const result = await callApi((api) => api.ledger.listAccounts({ includeArchived }))
    if (!result.ok) {
      setError(result.error)
      return
    }
    setError(null)
    setAccounts(result.data)
  }, [includeArchived])

  useEffect(() => {
    void load()
  }, [load])

  useRegisterCommands(
    useMemo<Command[]>(
      () => [
        {
          id: 'ledger.new-account',
          title: 'New account',
          section: 'Accounts',
          keywords: ['chart', 'ledger', 'create'],
          run: () => setCreateOpen(true),
        },
      ],
      [],
    ),
  )

  const rows = useMemo(() => filterChart(accounts ?? [], query), [accounts, query])

  return (
    <ScreenFrame
      isInset
      width="list"
      title="Chart of accounts"
      lede="Every account these books can post to. Rename, renumber or archive anything — the software depends on the roles, not the codes."
      actions={
        <Button icon="plus" variant="primary" onClick={() => setCreateOpen(true)}>
          New account
        </Button>
      }
    >
      <div className="stack">
        {error && <FailureNotice error={error} context="ledger" />}

        <div className="toolbar">
          <Input
            label="Search"
            isLabelHidden
            placeholder="Search by code, name or role"
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

        {accounts === null ? (
          <p className="prose prose--muted">Reading the chart…</p>
        ) : rows.length === 0 ? (
          <Notice tone="info" title="Nothing matches that">
            <p>
              No account has {query.trim()} in its code, name or role.
              {!includeArchived && ' Archived accounts are hidden — turn them on to include them.'}
            </p>
          </Notice>
        ) : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th scope="col">Code</th>
                <th scope="col">Name</th>
                <th scope="col">Type</th>
                <th scope="col">Roles</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ account, isMatch }) => (
                <AccountRow
                  key={account.id}
                  account={account}
                  isMatch={isMatch}
                  isSearching={query.trim() !== ''}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>

      <NewAccountDialog
        key={isCreateOpen ? 'open' : 'closed'}
        isOpen={isCreateOpen}
        accounts={accounts ?? []}
        onClose={() => setCreateOpen(false)}
        onCreated={(created) => {
          setCreateOpen(false)
          show({
            tone: 'success',
            title: 'Account added',
            body: `${accountLabel(created)} is in the chart.`,
          })
          void load()
        }}
      />
    </ScreenFrame>
  )
}

interface AccountRowProps {
  account: Account
  isMatch: boolean
  isSearching: boolean
}

function AccountRow({ account, isMatch, isSearching }: AccountRowProps): JSX.Element {
  /* A row kept only to hold a match in place is dimmed, so the indentation still reads
   * as a tree without the ancestors competing with what was searched for. */
  const isContext = isSearching && !isMatch
  const classes = [
    'ledger-table__row',
    account.isGroup ? 'ledger-table__row--group' : '',
    account.isArchived ? 'ledger-table__row--archived' : '',
    isContext ? 'ledger-table__row--context' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <tr className={classes}>
      <td className="ledger-table__code">{account.code}</td>
      <td>
        <span style={{ paddingInlineStart: `${account.depth * 1.25}rem` }}>{account.name}</span>
        {account.isArchived && (
          <>
            {' '}
            <Badge tone="neutral">Archived</Badge>
          </>
        )}
      </td>
      <td className="ledger-table__muted">{accountTypeLabel(account.type)}</td>
      <td className="ledger-table__muted">{account.roles.join(', ')}</td>
    </tr>
  )
}

// ---- Adding an account -----------------------------------------------------

interface NewAccountDialogProps {
  isOpen: boolean
  accounts: readonly Account[]
  onClose: () => void
  onCreated: (account: Account) => void
}

/**
 * A new account.
 *
 * `type` is chosen here and never again — every figure posted to an account is
 * classified by it, so changing it later would silently move a balance between the
 * balance sheet and the profit and loss. The parent list narrows to the same type for
 * the same reason: a child carries its parent's type.
 */
function NewAccountDialog({
  isOpen,
  accounts,
  onClose,
  onCreated,
}: NewAccountDialogProps): JSX.Element {
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [type, setType] = useState<AccountType>('asset')
  const [parentId, setParentId] = useState('')
  const [isGroup, setIsGroup] = useState(false)
  const [isBusy, setBusy] = useState(false)
  const [error, setError] = useState<AppError | null>(null)

  const parents = useMemo(() => parentsForType(accounts, type), [accounts, type])
  const canSubmit = code.trim() !== '' && name.trim() !== '' && !isBusy

  const submit = useCallback(async () => {
    if (!canSubmit) return
    setBusy(true)
    setError(null)

    const result = await callApi((api) =>
      api.ledger.createAccount({
        code: code.trim(),
        name: name.trim(),
        type,
        parentId: parentId === '' ? null : parentId,
        isGroup,
      }),
    )
    setBusy(false)

    if (!result.ok) {
      setError(result.error)
      return
    }
    onCreated(result.data)
  }, [canSubmit, code, name, type, parentId, isGroup, onCreated])

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      title="New account"
      description="The type is fixed once the account exists — every figure posted to it is classified by that type."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={() => void submit()}
            disabled={!canSubmit}
            isBusy={isBusy}
          >
            Add account
          </Button>
        </>
      }
    >
      <div className="stack">
        {error && <FailureNotice error={error} context="ledger" />}

        <Input
          label="Code"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          placeholder="1250"
        />
        <Input
          label="Name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Petty Cash"
        />

        <label className="field">
          <span className="field__label">Type</span>
          <select
            className="field__control"
            value={type}
            onChange={(event) => {
              setType(event.target.value as AccountType)
              /* The old parent may be the wrong type now, and a child carries its
               * parent's type — so the choice is cleared rather than silently kept. */
              setParentId('')
            }}
          >
            {ACCOUNT_TYPE_ORDER.map((value) => (
              <option key={value} value={value}>
                {accountTypeLabel(value)}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span className="field__label">Inside</span>
          <select
            className="field__control"
            value={parentId}
            onChange={(event) => setParentId(event.target.value)}
          >
            <option value="">Top level</option>
            {parents.map((parent) => (
              <option key={parent.id} value={parent.id}>
                {accountLabel(parent)}
              </option>
            ))}
          </select>
        </label>

        <label className="toolbar__toggle">
          <input
            type="checkbox"
            checked={isGroup}
            onChange={(event) => setIsGroup(event.target.checked)}
          />
          This is a group — it totals the accounts inside it and holds no figures of its own
        </label>
      </div>
    </Dialog>
  )
}

registerScreens([
  {
    id: 'chart-of-accounts',
    title: 'Chart of accounts',
    area: 'workspace',
    nav: { label: 'Chart of accounts', icon: 'accounts', group: 'accounts', order: 1 },
    render: () => <ChartOfAccounts />,
  },
])
