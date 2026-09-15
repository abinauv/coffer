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
 *
 * RENAME, RENUMBER, MOVE AND ARCHIVE (B24). The lede has always said all four could be done
 * and nothing on the screen did any of them, though `ledger.updateAccount` took each. An
 * account's name opens it; the row carries Archive. The TYPE is never offered — every figure
 * already posted was classified by it — and an account the software posts through (a role)
 * is not offered for archiving at all: nothing could post there afterwards, main refuses it,
 * and no screen yet moves a role elsewhere.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { JSX } from 'react'
import { Badge, Button, Dialog, Input, Select } from '@renderer/components/atoms'
import { callApi } from '@renderer/lib/api'
import type { Command } from '@renderer/lib/command-registry'
import { registerScreens } from '@renderer/lib/screens'
import { useRegisterCommands } from '@renderer/store/commands'
import { useToasts } from '@renderer/store/toasts'
import type { Account, AccountType, AppError } from '@shared/dto'
import { CheckboxField } from '../components/CheckboxField'
import { FailureNotice } from '../components/FailureNotice'
import { ListToolbar } from '../components/ListToolbar'
import { RegisterEmpty } from '../components/RegisterToolbar'
import { RegisterSkeleton, type SkeletonColumn } from '../components/RegisterSkeleton'
import { ScreenFrame } from '../components/ScreenFrame'
import { accountLabel, filterChart, parentsForAccount, parentsForType } from '../lib/chart-tree'
import { accountTypeLabel, ACCOUNT_TYPE_ORDER } from '../lib/ledger-format'
import { archivedNote } from '../lib/register-view'

/* Code, name, type, roles, actions. */
const COLUMNS: readonly SkeletonColumn[] = [
  { width: '6rem' },
  { width: 'minmax(10rem, 2fr)' },
  { width: '7rem' },
  { width: '1fr' },
  { width: '6rem', align: 'end' },
]

export function ChartOfAccounts(): JSX.Element {
  const { show } = useToasts()
  const [accounts, setAccounts] = useState<Account[] | null>(null)
  const [error, setError] = useState<AppError | null>(null)
  const [query, setQuery] = useState('')
  const [includeArchived, setIncludeArchived] = useState(false)
  const [isCreateOpen, setCreateOpen] = useState(false)
  const [editing, setEditing] = useState<Account | null>(null)

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

  const setArchived = useCallback(
    async (account: Account, archived: boolean) => {
      const result = await callApi((api) =>
        api.ledger.updateAccount({ id: account.id, isArchived: archived }),
      )
      if (!result.ok) {
        show({ tone: 'danger', title: 'That did not work', body: result.error.message })
        return
      }
      show({
        tone: 'success',
        title: archived ? 'Archived' : 'Back in use',
        body: archived
          ? `${accountLabel(account)} takes no new posting. Everything already posted to it stays in the books and in every report.`
          : `${accountLabel(account)} can be posted to again.`,
      })
      void load()
    },
    [load, show],
  )

  const rows = useMemo(() => filterChart(accounts ?? [], query), [accounts, query])
  const searched = query.trim()

  return (
    <ScreenFrame
      isInset
      width="list"
      title="Chart of accounts"
      lede="Every account these books can post to. Rename, renumber, move or archive anything — the software depends on the roles, not the codes."
      actions={
        <Button icon="plus" variant="primary" onClick={() => setCreateOpen(true)}>
          New account
        </Button>
      }
    >
      <div className="stack">
        {error && <FailureNotice error={error} context="ledger" />}

        <ListToolbar
          placeholder="Search by code, name or role"
          query={query}
          onQueryChange={setQuery}
          includeArchived={includeArchived}
          onIncludeArchivedChange={setIncludeArchived}
        />

        {accounts === null ? (
          error === null && <RegisterSkeleton label="the chart of accounts" columns={COLUMNS} />
        ) : rows.length === 0 ? (
          <RegisterEmpty
            plural="accounts"
            isFiltered={searched !== ''}
            sentence="Add the first account to post to."
            newLabel="Add the first account"
            onNew={() => setCreateOpen(true)}
            filteredSentence={`No account has ${searched} in its code, name or role.${archivedNote(includeArchived)}`}
            clearLabel="Clear the search"
            onClear={() => setQuery('')}
          />
        ) : (
          <div className="register">
            <table className="ledger-table register__table">
              <thead>
                <tr>
                  <th scope="col">Code</th>
                  <th scope="col">Name</th>
                  <th scope="col">Type</th>
                  <th scope="col">Roles</th>
                  <th scope="col">
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ account, isMatch }) => (
                  <AccountRow
                    key={account.id}
                    account={account}
                    isMatch={isMatch}
                    isSearching={searched !== ''}
                    onOpen={() => setEditing(account)}
                    onArchive={() => void setArchived(account, !account.isArchived)}
                  />
                ))}
              </tbody>
            </table>
          </div>
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

      <EditAccountDialog
        key={editing === null ? 'edit:closed' : `edit:${editing.id}`}
        account={editing}
        accounts={accounts ?? []}
        onClose={() => setEditing(null)}
        onSaved={(saved) => {
          setEditing(null)
          show({ tone: 'success', title: 'Saved', body: `${accountLabel(saved)} is up to date.` })
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
  onOpen: () => void
  onArchive: () => void
}

function AccountRow({
  account,
  isMatch,
  isSearching,
  onOpen,
  onArchive,
}: AccountRowProps): JSX.Element {
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
      <td className="register__name">
        <span style={{ paddingInlineStart: `${account.depth * 1.25}rem` }}>
          <Button variant="ghost" size="sm" onClick={onOpen}>
            {account.name}
          </Button>
        </span>
        {account.isArchived && (
          <>
            {' '}
            <Badge tone="neutral">Archived</Badge>
          </>
        )}
      </td>
      <td className="ledger-table__muted">{accountTypeLabel(account.type)}</td>
      <td className="ledger-table__code ledger-table__muted">{account.roles.join(', ')}</td>
      <td className="register__actions">
        {/* Not offered while the software posts through it: main refuses, and nothing on any
            screen yet moves a role to another account, so the button would be a dead end.
            The edit dialog says why. An archived one can always be restored. */}
        {(account.isArchived || account.roles.length === 0) && (
          <Button variant="ghost" size="sm" onClick={onArchive}>
            {account.isArchived ? 'Restore' : 'Archive'}
          </Button>
        )}
      </td>
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
          isIdentifier
          value={code}
          hint="Any code you like. Two accounts may not share one."
          onChange={(event) => setCode(event.target.value)}
        />
        <Input label="Name" value={name} onChange={(event) => setName(event.target.value)} />

        <Select
          label="Type"
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
        </Select>

        <Select
          label="Inside"
          value={parentId}
          onChange={(event) => setParentId(event.target.value)}
        >
          <option value="">Top level</option>
          {parents.map((parent) => (
            <option key={parent.id} value={parent.id}>
              {accountLabel(parent)}
            </option>
          ))}
        </Select>

        <CheckboxField isChecked={isGroup} onChange={setIsGroup}>
          This is a group — it totals the accounts inside it and holds no figures of its own
        </CheckboxField>
      </div>
    </Dialog>
  )
}

// ---- Editing an account ----------------------------------------------------

interface EditAccountDialogProps {
  /** Null when nothing is being edited. */
  account: Account | null
  accounts: readonly Account[]
  onClose: () => void
  onSaved: (account: Account) => void
}

/**
 * Renaming, renumbering, moving and describing an account.
 *
 * WHAT IS NOT HERE: the type, and whether it is a group. `UpdateAccountInput` carries
 * neither, because both decide how every figure already posted is read. The type is stated
 * as a fact so its absence reads as a rule rather than a missing field.
 *
 * Every editable field is sent every time. An unchanged code is not a clash with itself —
 * main checks the code against every OTHER account — and an unchanged parent is not a move.
 */
function EditAccountDialog({
  account,
  accounts,
  onClose,
  onSaved,
}: EditAccountDialogProps): JSX.Element {
  const [code, setCode] = useState(account?.code ?? '')
  const [name, setName] = useState(account?.name ?? '')
  const [parentId, setParentId] = useState(account?.parentId ?? '')
  const [description, setDescription] = useState(account?.description ?? '')
  const [isBusy, setBusy] = useState(false)
  const [error, setError] = useState<AppError | null>(null)

  const parents = useMemo(
    () => (account === null ? [] : parentsForAccount(accounts, account)),
    [accounts, account],
  )
  const canSubmit = account !== null && code.trim() !== '' && name.trim() !== '' && !isBusy

  const submit = useCallback(async () => {
    if (account === null || !canSubmit) return
    setBusy(true)
    setError(null)

    const trimmedDescription = description.trim()
    const result = await callApi((api) =>
      api.ledger.updateAccount({
        id: account.id,
        code: code.trim(),
        name: name.trim(),
        parentId: parentId === '' ? null : parentId,
        description: trimmedDescription === '' ? null : trimmedDescription,
      }),
    )
    setBusy(false)

    if (!result.ok) {
      setError(result.error)
      return
    }
    onSaved(result.data)
  }, [account, canSubmit, code, description, name, onSaved, parentId])

  return (
    <Dialog
      isOpen={account !== null}
      onClose={onClose}
      title={account === null ? 'Edit account' : `Edit ${accountLabel(account)}`}
      description="Rename, renumber or move it. Everything already posted to it follows, because postings refer to the account and not to its code."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={() => void submit()}
            disabled={!canSubmit}
            isBusy={isBusy}
          >
            Save
          </Button>
        </>
      }
    >
      <div className="stack">
        {error && <FailureNotice error={error} context="ledger" />}

        {account !== null && (
          <p className="prose prose--muted">
            Filed under {accountTypeLabel(account.type)}
            {account.isGroup ? ', as a group that totals the accounts inside it' : ''}. That cannot
            be changed — every figure posted to it was classified by it. To change it, add the
            account you meant and move the balance across with a journal.
          </p>
        )}

        {account !== null && account.roles.length > 0 && (
          <p className="prose prose--muted">
            The software posts through it as {account.roles.join(', ')}, so it cannot be archived
            while it fills {account.roles.length === 1 ? 'that role' : 'those roles'}.
          </p>
        )}

        <Input
          label="Code"
          isIdentifier
          value={code}
          hint="Two accounts may not share a code."
          onChange={(event) => setCode(event.target.value)}
        />
        <Input label="Name" value={name} onChange={(event) => setName(event.target.value)} />

        <Select
          label="Inside"
          value={parentId}
          hint="Only groups of the same type, and never one inside this account."
          onChange={(event) => setParentId(event.target.value)}
        >
          <option value="">Top level</option>
          {parents.map((parent) => (
            <option key={parent.id} value={parent.id}>
              {accountLabel(parent)}
            </option>
          ))}
        </Select>

        <Input
          label="Description"
          value={description}
          hint="What goes here, for whoever posts to it next. Not printed on anything."
          onChange={(event) => setDescription(event.target.value)}
        />
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
