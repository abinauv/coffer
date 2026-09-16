/*
 * The company picker — what Coffer is when no company is open.
 *
 * Everything reachable without a passphrase lives here: the list, and the four ways a
 * company can get onto it (create one, add a file already on disk, restore a backup, or
 * have been here already). Nothing on this screen reads a single figure from anybody's
 * books, because nothing has been decrypted yet.
 *
 * WITH NO COMPANIES, IT IS THE WELCOME. A first launch has nothing to list, so instead of
 * an empty list it says what Coffer is in one sentence, offers the two ways in — create a
 * company, or open a file already on disk — and the two ways back to books that exist
 * somewhere: a recovery code for a file whose passphrase is lost, and a backup.
 *
 * ONE RULE WORTH STATING. "Forget" removes a row from a list. It never deletes a file,
 * and the confirmation says so in those words — a user who reads "remove" as "delete" and
 * hesitates has been failed by the copy, and one who reads it the other way round has
 * been failed much worse.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { JSX } from 'react'
import { Badge, Button, Dialog, Icon, Input } from '@renderer/components/atoms'
import { BrandMark } from '@renderer/components/shell/BrandMark'
import { callApi } from '@renderer/lib/api'
import type { Command } from '@renderer/lib/command-registry'
import { makeRoute } from '@renderer/lib/routing'
import { useRegisterCommands } from '@renderer/store/commands'
import { useNavigation } from '@renderer/store/navigation'
import { registerScreens } from '@renderer/lib/screens'
import { useToasts } from '@renderer/store/toasts'
import type { CompanySummary } from '@shared/dto'
import { BRAND } from '../../../../branding'
import { FailureNotice } from '../components/FailureNotice'
import { Notice } from '../components/Notice'
import { RestoreDialog } from '../components/RestoreDialog'
import { ScreenFrame } from '../components/ScreenFrame'
import { TitleBarSync } from '../components/TitleBarSync'
import { describeAvailability } from '../lib/availability'
import { describeCreated, describeLastOpened } from '../lib/dates'
import { failureTitle } from '../lib/messages'
import { validateRename } from '../lib/forms'
import { useCompanies } from '../lib/use-companies'

export function CompanyPicker(): JSX.Element {
  const { route, navigate } = useNavigation()
  const { show } = useToasts()
  const { companies, error, isLoading, refresh } = useCompanies()

  const [renaming, setRenaming] = useState<CompanySummary | null>(null)
  const [forgetting, setForgetting] = useState<CompanySummary | null>(null)
  /* A screen that cannot do something itself sends the user here asking for it —
   * `route.params.action`: restore a backup, find a file, or remove an entry. Read once, at
   * mount: the picker is remounted on the way in, and nothing may spring open again after
   * it has been dismissed. */
  const [requested] = useState(() => ({
    action: route.params['action'],
    id: route.params['id'],
  }))
  const [isRestoreOpen, setRestoreOpen] = useState(() => requested.action === 'restore')
  const [hasActedOnRequest, setActedOnRequest] = useState(false)
  const [isAdding, setAdding] = useState(false)

  const goCreate = useCallback(() => navigate(makeRoute('welcome', 'create')), [navigate])

  /**
   * Point Coffer at a company file that is already on disk. Answers the entry it added, or
   * null when nothing was — the dialog closed, or the file was refused and a toast said why.
   */
  const chooseAndAdd = useCallback(async (): Promise<CompanySummary | null> => {
    setAdding(true)
    try {
      const chosen = await callApi((api) => api.system.chooseCompanyFile())
      if (!chosen.ok) {
        show({ tone: 'danger', title: failureTitle(chosen.error), body: chosen.error.message })
        return null
      }
      /* Null is the user closing the dialog. Not an error, and not worth a toast. */
      const filePath = chosen.data
      if (filePath === null) return null

      const added = await callApi((api) => api.companies.addExisting(filePath))
      if (!added.ok) {
        show({ tone: 'danger', title: failureTitle(added.error), body: added.error.message })
        return null
      }
      await refresh()
      return added.data
    } finally {
      setAdding(false)
    }
  }, [refresh, show])

  const addExisting = useCallback(async () => {
    const added = await chooseAndAdd()
    if (added === null) return
    show({
      tone: 'success',
      title: `${added.displayName} is on your list`,
      body:
        added.availability === 'vault-missing'
          ? 'Its keys are not beside it, so it cannot be opened yet. The list explains what to do.'
          : 'Open it with its passphrase whenever you need it.',
    })
  }, [chooseAndAdd, show])

  /* From the welcome, where there is no list to pick from: the file first, then the code. */
  const recoverFromFile = useCallback(async () => {
    const added = await chooseAndAdd()
    if (added !== null) navigate(makeRoute('welcome', 'recover', { id: added.id }))
  }, [chooseAndAdd, navigate])

  /* The removal asked for waits for the list, because it names a company on it. */
  useEffect(() => {
    if (hasActedOnRequest || companies === null) return
    if (requested.action === 'add-existing') {
      setActedOnRequest(true)
      void addExisting()
    } else if (requested.action === 'forget') {
      setActedOnRequest(true)
      setForgetting(companies.find((company) => company.id === requested.id) ?? null)
    }
  }, [hasActedOnRequest, companies, requested, addExisting])

  useRegisterCommands(
    useMemo<Command[]>(
      () => [
        {
          id: 'company.create',
          title: 'Create a company',
          section: 'Company',
          keywords: ['new', 'start', 'first'],
          run: goCreate,
        },
        {
          id: 'company.add-existing',
          title: 'Add an existing company',
          section: 'Company',
          keywords: ['open file', 'import', 'locate'],
          run: () => void addExisting(),
        },
      ],
      [goCreate, addExisting],
    ),
  )

  const restoreDialog = (
    <RestoreDialog isOpen={isRestoreOpen} onClose={() => setRestoreOpen(false)} onDone={refresh} />
  )

  /* Nothing until the list has answered. Drawing "Your companies" while it loads would flash
   * a list screen at a first launch before the welcome replaced it. */
  if (error === null && companies === null) {
    return <div className="welcome" aria-busy="true" />
  }

  if (error === null && companies !== null && companies.length === 0) {
    return (
      <>
        <Welcome
          isAdding={isAdding}
          onCreate={goCreate}
          onOpenFile={() => void addExisting()}
          onRecover={() => void recoverFromFile()}
          onRestore={() => setRestoreOpen(true)}
        />
        {restoreDialog}
      </>
    )
  }

  return (
    <ScreenFrame
      width="list"
      title="Your companies"
      lede="Each company is its own encrypted file, on this machine. Nothing here is readable until you unlock it."
      actions={
        <>
          <Button icon="refresh" variant="ghost" onClick={() => void refresh()} isBusy={isLoading}>
            Refresh
          </Button>
          <Button icon="folder" onClick={() => void addExisting()} isBusy={isAdding}>
            Add an existing company
          </Button>
          <Button icon="archive" onClick={() => setRestoreOpen(true)}>
            Restore a backup
          </Button>
          <Button variant="primary" icon="plus" onClick={goCreate}>
            Create a company
          </Button>
        </>
      }
    >
      {error && (
        <FailureNotice error={error} context="list" onAction={{ refresh: () => void refresh() }} />
      )}

      {companies !== null && companies.length > 0 && (
        <ul className="company-list">
          {companies.map((company) => (
            <li key={company.id}>
              <CompanyRow
                company={company}
                onOpen={() => navigate(makeRoute('welcome', 'unlock', { id: company.id }))}
                onRecover={() => navigate(makeRoute('welcome', 'recover', { id: company.id }))}
                onRename={() => setRenaming(company)}
                onForget={() => setForgetting(company)}
                onFindFile={() => void addExisting()}
                onRestore={() => setRestoreOpen(true)}
              />
            </li>
          ))}
        </ul>
      )}

      {/* Keyed on the company: the dialog's draft name belongs to the company it was
          opened for, and remounting is how it starts from the right one. */}
      <RenameDialog
        key={renaming?.id ?? 'rename-none'}
        company={renaming}
        onClose={() => setRenaming(null)}
        onDone={refresh}
      />
      <ForgetDialog company={forgetting} onClose={() => setForgetting(null)} onDone={refresh} />
      {restoreDialog}
    </ScreenFrame>
  )
}

// ---- The list --------------------------------------------------------------

interface CompanyRowProps {
  company: CompanySummary
  onOpen: () => void
  onRecover: () => void
  onRename: () => void
  onForget: () => void
  onFindFile: () => void
  onRestore: () => void
}

function CompanyRow({
  company,
  onOpen,
  onRecover,
  onRename,
  onForget,
  onFindFile,
  onRestore,
}: CompanyRowProps): JSX.Element {
  const { show } = useToasts()
  const notice = describeAvailability(company)

  const reveal = useCallback(async () => {
    const result = await callApi((api) => api.system.revealInFileManager(company.filePath))
    if (!result.ok) {
      show({ tone: 'danger', title: failureTitle(result.error), body: result.error.message })
    }
  }, [company.filePath, show])

  return (
    <article className="company" data-available={notice.canOpen ? 'true' : 'false'}>
      <div className="company__identity">
        <Icon name="building" size={18} className="company__mark" />
        <div className="company__names">
          <h2 className="company__name truncate" title={company.displayName}>
            {company.displayName}
          </h2>
          <p className="company__path truncate selectable" title={company.filePath}>
            {company.filePath}
          </p>
          <p className="company__meta">
            {describeLastOpened(company.lastOpenedAt)} · {describeCreated(company.createdAt)}
          </p>
        </div>
        {notice.badge && <Badge tone={notice.badge.tone}>{notice.badge.label}</Badge>}
      </div>

      {notice.headline !== null && (
        <Notice tone={company.availability === 'vault-missing' ? 'danger' : 'warning'}>
          <p>
            <strong>{notice.headline}</strong> {notice.body}
          </p>
        </Notice>
      )}

      <div className="company__actions">
        {notice.canOpen && (
          <Button variant="primary" icon="lock" onClick={onOpen}>
            Open
          </Button>
        )}
        {notice.action === 'add-existing' && (
          <Button icon="folder" onClick={onFindFile}>
            Find the file
          </Button>
        )}
        {notice.action === 'restore' && (
          <Button icon="archive" onClick={onRestore}>
            Restore from a backup
          </Button>
        )}
        {notice.canOpen && (
          <Button variant="ghost" onClick={onRecover}>
            Use a recovery code
          </Button>
        )}
        <span className="company__spacer" />
        <Button variant="ghost" onClick={onRename}>
          Rename
        </Button>
        <Button variant="ghost" onClick={() => void reveal()}>
          Show in folder
        </Button>
        <Button variant="ghost" onClick={onForget}>
          Remove from list
        </Button>
      </div>
    </article>
  )
}

// ---- The welcome -----------------------------------------------------------

interface WelcomeProps {
  isAdding: boolean
  onCreate: () => void
  onOpenFile: () => void
  onRecover: () => void
  onRestore: () => void
}

/**
 * The first thing a first launch shows.
 *
 * Four promises at the foot, and each is a fact about this build rather than a slogan:
 * there is no account and no subscription because there is no server, no telemetry because
 * nothing is sent, and it works offline because the Content Security Policy forbids every
 * remote origin (docs/design.md). A promise that stops being true comes off the list.
 */
function Welcome({
  isAdding,
  onCreate,
  onOpenFile,
  onRecover,
  onRestore,
}: WelcomeProps): JSX.Element {
  return (
    <div className="welcome">
      <TitleBarSync />
      <div className="welcome__main">
        <span className="welcome__icon" aria-hidden="true">
          <BrandMark size={40} />
        </span>
        <div className="welcome__titles">
          <h1 className="welcome__title">Welcome to {BRAND.name}</h1>
          <p className="welcome__lede">
            Your books are kept encrypted, in files on this computer. There is no account to create
            and nothing to sign in to. Start by making a company.
          </p>
        </div>
        <div className="welcome__actions">
          <Button variant="primary" icon="plus" isFullWidth onClick={onCreate}>
            Create a company
          </Button>
          <Button icon="folder" isFullWidth isBusy={isAdding} onClick={onOpenFile}>
            Open an existing company file…
          </Button>
        </div>
        <p className="welcome__links">
          <span>
            Lost your passphrase?{' '}
            <Button variant="ghost" size="sm" onClick={onRecover} disabled={isAdding}>
              Use a recovery code
            </Button>
          </span>
          <span aria-hidden="true">·</span>
          <Button variant="ghost" size="sm" onClick={onRestore}>
            Restore from a backup
          </Button>
        </p>
      </div>
      <ul className="welcome__promises" aria-label="What Coffer does without">
        <li>No account</li>
        <li>No subscription</li>
        <li>No telemetry</li>
        <li>Works with the internet off</li>
      </ul>
    </div>
  )
}

// ---- Rename ----------------------------------------------------------------

interface DialogProps {
  company: CompanySummary | null
  onClose: () => void
  onDone: () => Promise<void>
}

function RenameDialog({ company, onClose, onDone }: DialogProps): JSX.Element {
  const { show } = useToasts()
  const current = company?.displayName ?? ''
  const [value, setName] = useState(current)
  const [isBusy, setBusy] = useState(false)
  const state = validateRename(value, current)

  const close = useCallback(() => {
    onClose()
  }, [onClose])

  const submit = useCallback(async () => {
    if (company === null || !state.canSubmit) return
    setBusy(true)
    const result = await callApi((api) => api.companies.rename(company.id, value.trim()))
    setBusy(false)
    if (!result.ok) {
      show({ tone: 'danger', title: failureTitle(result.error), body: result.error.message })
      return
    }
    await onDone()
    close()
    show({ tone: 'success', title: `Renamed to ${result.data.displayName}` })
  }, [company, state.canSubmit, value, show, onDone, close])

  return (
    <Dialog
      isOpen={company !== null}
      onClose={close}
      title="Rename this company"
      description="The name in your list changes. The file on disk keeps the name it was created with — renaming an open database is a good way to lose one."
      size="sm"
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button
            variant="primary"
            onClick={() => void submit()}
            disabled={!state.canSubmit}
            isBusy={isBusy}
          >
            Rename
          </Button>
        </>
      }
    >
      <Input
        label="Name"
        value={value}
        error={state.errors.displayName}
        onChange={(event) => setName(event.target.value)}
        maxLength={120}
      />
    </Dialog>
  )
}

// ---- Forget ----------------------------------------------------------------

function ForgetDialog({ company, onClose, onDone }: DialogProps): JSX.Element {
  const { show } = useToasts()
  const [isBusy, setBusy] = useState(false)

  const submit = useCallback(async () => {
    if (company === null) return
    setBusy(true)
    const result = await callApi((api) => api.companies.forget(company.id))
    setBusy(false)
    if (!result.ok) {
      show({ tone: 'danger', title: failureTitle(result.error), body: result.error.message })
      return
    }
    await onDone()
    onClose()
    show({
      tone: 'info',
      title: `${company.displayName} was removed from your list`,
      body: 'Its files are untouched. Add them again whenever you want it back.',
    })
  }, [company, show, onDone, onClose])

  return (
    <Dialog
      isOpen={company !== null}
      onClose={onClose}
      title="Remove this company from the list?"
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>Keep it</Button>
          <Button variant="danger" onClick={() => void submit()} isBusy={isBusy}>
            Remove from list
          </Button>
        </>
      }
    >
      <p className="prose">
        This removes <strong>{company?.displayName}</strong> from Coffer&rsquo;s list and leaves the
        files exactly where they are. <strong>Nothing is deleted.</strong>
      </p>
      <p className="prose prose--muted selectable">{company?.filePath}</p>
      <p className="prose">
        The database and its vault stay in that folder, and adding them back with &ldquo;Add an
        existing company&rdquo; restores this entry as it was.
      </p>
    </Dialog>
  )
}

registerScreens([
  {
    id: 'companies',
    title: 'Your companies',
    area: 'welcome',
    render: () => <CompanyPicker />,
  },
])
