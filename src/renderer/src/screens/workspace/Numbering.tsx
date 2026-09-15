/*
 * How documents are numbered — and, for an older company file, the one screen that can
 * make it possible to number anything at all.
 *
 * WHAT WAS MISSING UNTIL NOW. Nine kinds of thing draw their number from
 * `numbering_series` (migration 0007) and nothing in the product could show one, let
 * alone change one. Worse: `seedDefaultSeries` runs only from `setUpBooks`, which runs
 * once when a company file is created, so a file made before 0012 has NO series and can
 * issue NOTHING — no invoice, no receipt — and a file made before 0015 has no `refund`
 * and no `refund-received` series and can record neither. Neither had any repair from
 * inside the app. `numbering.seedDefaults` is that repair and this screen is where it is
 * offered.
 *
 * ---------------------------------------------------------------------------
 * THE PREVIEW IS MAIN'S, AND IT IS OF A SERIES AS SAVED
 *
 * `INV/2026-27/0042` is the only useful way to show what a prefix and a width mean, and
 * the only honest way to produce it is to ask the code that will actually issue the
 * number — `numbering.preview`, which goes through `formatDocumentNumber` and moves no
 * counter. Composing one here would be a second implementation of the number's shape, and
 * db/repos/numbering.ts spends a paragraph on the day the two stop agreeing.
 *
 * The consequence is stated rather than hidden: `PreviewNumberInput` takes a series ID, so
 * there is nothing to preview until a series exists. A new series says so; a saved one is
 * previewed on its row, in the editor, and again in the sentence that confirms the save —
 * "The next sales invoice will be INV/2026-27/0042" is worth more than "Saved".
 *
 * `fiscalYearLabel` IS DECIDED BY `previewYearFor` AND ALWAYS SENT. It is nullable and
 * required, which is not the same as optional: null means this number is in no fiscal
 * year, and an absent field means a screen forgot — main refuses the second rather than
 * guessing. The year itself comes from the periods these books keep, because the label is
 * the regime's spelling and the renderer does not know how a year is named.
 *
 * ---------------------------------------------------------------------------
 * NOTHING HERE TOUCHES A COUNTER, AND NOTHING HERE EVER WILL
 *
 * There is no "reset the counter", no "set the next number" and no way to give a number
 * back. A number that has been handed out is spent: rule 46(b) wants the series
 * consecutive, and a gap is a conversation with an officer about an invoice nobody can
 * produce. The repository has no `resetCounter` to call even if this screen wanted one.
 * The counter is shown because an accountant checks it, and the rule is said in words on
 * the screen so that its absence reads as a decision rather than as a missing feature.
 *
 * ARCHIVED SERIES ARE LOADED AND HIDDEN, rather than not loaded. `seedDefaults` skips a
 * kind that already has a series whether or not it is archived, so "which kinds are
 * missing" has to be asked of every row: computing it from the visible ones would offer a
 * repair that creates nothing and then report nought as though something had failed.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { JSX } from 'react'
import { Badge, Button, Dialog, Input, Select } from '@renderer/components/atoms'
import { callApi } from '@renderer/lib/api'
import type { Command } from '@renderer/lib/command-registry'
import { registerScreens } from '@renderer/lib/screens'
import { useRegisterCommands } from '@renderer/store/commands'
import { useToasts } from '@renderer/store/toasts'
import type {
  AppError,
  CreateNumberingSeriesInput,
  NumberPreview,
  NumberingReset,
  NumberingSeriesRecord,
  UpdateNumberingSeriesInput,
} from '@shared/dto'
import { CheckboxField } from '../components/CheckboxField'
import { FailureNotice } from '../components/FailureNotice'
import { ListToolbar } from '../components/ListToolbar'
import { Notice } from '../components/Notice'
import { RegisterSkeleton, type SkeletonColumn } from '../components/RegisterSkeleton'
import { ScreenFrame } from '../components/ScreenFrame'
import {
  NUMBERED_KINDS,
  currentFiscalYear,
  describeRepair,
  fiscalYearsFrom,
  groupSeriesByKind,
  groupWarning,
  kindsWithoutSeries,
  needsFiscalYear,
  numberedKindLabel,
  previewYearFor,
  type FiscalYear,
} from '../lib/numbering-view'
import { todayISO } from '../lib/report-view'

/** What the two reset choices are called. A total record over the union (§1.9). */
const RESET_LABELS: Record<NumberingReset, string> = {
  'fiscal-year': 'Restart each financial year',
  never: 'Run on for ever',
}

/*
 * The choices, in the order the picker offers them.
 *
 * Read off the record's keys rather than written out beside it, so a third way of
 * counting added to `NumberingReset` has to be given a label — the record refuses to
 * compile without one — and is then offered here with no second edit. The cast is
 * `Object.keys` losing what the record's type already said.
 */
const RESET_OPTIONS = Object.keys(RESET_LABELS) as NumberingReset[]

/* Series, prefix, width, next number, next in sequence, default, actions. */
const COLUMNS: readonly SkeletonColumn[] = [
  { width: 'minmax(8rem, 1fr)' },
  { width: '6rem' },
  { width: '4rem', align: 'end' },
  { width: '10rem' },
  { width: '6rem', align: 'end' },
  { width: '5rem' },
  { width: '10rem', align: 'end' },
]

/** The name the repair carries in both places it is offered, so it is one button. */
const REPAIR_LABEL = 'Create the missing series'

/** The heading over the prompt that appears when a kind has no series at all. */
const REPAIR_TITLE = 'Some kinds have no series'

export function Numbering(): JSX.Element {
  const { show } = useToasts()

  const [series, setSeries] = useState<readonly NumberingSeriesRecord[] | null>(null)
  const [years, setYears] = useState<readonly FiscalYear[]>([])
  const [year, setYear] = useState<string | null>(null)
  const [previews, setPreviews] = useState<Record<string, NumberPreview>>({})
  const [includeArchived, setIncludeArchived] = useState(false)
  const [editing, setEditing] = useState<NumberingSeriesRecord | 'new' | null>(null)
  const [error, setError] = useState<AppError | null>(null)
  const [repair, setRepair] = useState<string | null>(null)
  const [isRepairing, setRepairing] = useState(false)

  /*
   * Both loads together, and the archived rows always.
   *
   * The periods are what the fiscal year labels come from — the regime spells them and
   * the renderer must not — and a failure to read them is not fatal to this screen: the
   * series are still worth showing, and a preview that cannot say which year it is in is
   * refused by main with a sentence rather than drawn wrong.
   */
  const load = useCallback(async () => {
    const [periodsResult, listResult] = await Promise.all([
      callApi((api) => api.ledger.listPeriods()),
      callApi((api) => api.numbering.list({ includeArchived: true })),
    ])

    const found = periodsResult.ok ? fiscalYearsFrom(periodsResult.data) : []
    setYears(found)
    setYear((chosen) =>
      chosen !== null && found.some((option) => option.label === chosen)
        ? chosen
        : currentFiscalYear(found, todayISO()),
    )

    if (!listResult.ok) {
      setError(listResult.error)
      return
    }
    setError(null)
    setSeries(listResult.data)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  /*
   * One preview per series, in the year the picker is on.
   *
   * Runs when the list or the year changes and not otherwise, so the number on every row
   * is the number that series would actually hand out next. A preview that main refuses —
   * a year-scoped series in books with no fiscal years — simply has no entry, and the row
   * shows a dash rather than a number that would be a guess.
   */
  useEffect(() => {
    if (series === null) return
    let isCurrent = true

    void (async () => {
      const entries = await Promise.all(
        series.map(async (record) => {
          const result = await callApi((api) =>
            api.numbering.preview({
              seriesId: record.id,
              fiscalYearLabel: previewYearFor(record, year),
            }),
          )
          return result.ok ? ([record.id, result.data] as const) : null
        }),
      )
      if (!isCurrent) return
      setPreviews(Object.fromEntries(entries.filter((entry) => entry !== null)))
    })()

    return () => {
      isCurrent = false
    }
  }, [series, year])

  useRegisterCommands(
    useMemo<Command[]>(
      () => [
        {
          id: 'numbering.new-series',
          title: 'New numbering series',
          section: 'Numbering',
          keywords: ['prefix', 'invoice number', 'series', 'numbering'],
          run: () => setEditing('new'),
        },
      ],
      [],
    ),
  )

  const groups = useMemo(
    () => groupSeriesByKind(series ?? [], { includeArchived }),
    [series, includeArchived],
  )

  /*
   * Which kinds `seedDefaults` would actually create something for.
   *
   * Asked of every series rather than the visible ones — see the header. Nought of them
   * is the ordinary state, and the repair is still offered below; it is only the prompt at
   * the top that is conditional.
   */
  const missing = useMemo(() => (series === null ? [] : kindsWithoutSeries(series)), [series])

  const runRepair = useCallback(async () => {
    setRepairing(true)
    setRepair(null)
    const result = await callApi((api) => api.numbering.seedDefaults())
    setRepairing(false)

    if (!result.ok) {
      setError(result.error)
      return
    }
    setError(null)
    setRepair(describeRepair(result.data))
    void load()
  }, [load])

  /** The default flag, moved to a series, without opening the editor for one tick box. */
  const makeDefault = useCallback(
    async (record: NumberingSeriesRecord) => {
      const result = await callApi((api) =>
        api.numbering.update({ id: record.id, isDefault: true }),
      )
      if (!result.ok) {
        show({ tone: 'danger', title: 'That did not work', body: result.error.message })
        return
      }
      show({
        tone: 'success',
        title: 'Default changed',
        body: `A new ${numberedKindLabel(record.kind).toLowerCase()} now takes its number from ${record.label}.`,
      })
      void load()
    },
    [load, show],
  )

  const setArchived = useCallback(
    async (record: NumberingSeriesRecord, archived: boolean) => {
      const result = await callApi((api) => api.numbering.archive({ id: record.id, archived }))
      if (!result.ok) {
        show({ tone: 'danger', title: 'That did not work', body: result.error.message })
        return
      }
      show({
        tone: 'success',
        title: archived ? 'Archived' : 'Back in use',
        body: archived
          ? `${record.label} numbers nothing new. Every number it has already given out stays exactly where it is.`
          : `${record.label} can be used again. It carries on from where it had got to.`,
      })
      void load()
    },
    [load, show],
  )

  /** What to say once a series has been saved. The new number is the whole point. */
  const announceSave = useCallback(
    async (saved: NumberingSeriesRecord, wasNew: boolean) => {
      const result = await callApi((api) =>
        api.numbering.preview({
          seriesId: saved.id,
          fiscalYearLabel: previewYearFor(saved, year),
        }),
      )
      show({
        tone: 'success',
        title: wasNew ? 'Added' : 'Saved',
        body: result.ok
          ? `The next ${numberedKindLabel(saved.kind).toLowerCase()} on ${saved.label} will be ${result.data.preview}.`
          : `${saved.label} is up to date.`,
      })
    },
    [show, year],
  )

  return (
    <ScreenFrame
      isInset
      width="list"
      title="Numbering"
      lede="What a document's number looks like, and where the count has got to. A number that has been issued is never given back, so a counter only ever moves forward — there is nothing here that resets one."
      actions={
        <Button icon="plus" variant="primary" onClick={() => setEditing('new')}>
          New series
        </Button>
      }
    >
      <div className="stack">
        {error && <FailureNotice error={error} context="ledger" />}

        {missing.length > 0 && (
          <Notice tone="warning" title={REPAIR_TITLE}>
            <p>
              Nothing can be issued for a kind with no series, and{' '}
              {listKinds(missing.map((kind) => kind.pluralLabel))} have none. This happens to a
              company file made by an older version of Coffer, which created only the kinds that
              existed at the time.
            </p>
            <p>
              Adding them is safe: one series is created for each kind that has none, everything
              already here is left exactly as it is, and no counter moves.
            </p>
            <p>
              <Button variant="primary" onClick={() => void runRepair()} isBusy={isRepairing}>
                {REPAIR_LABEL}
              </Button>
            </p>
          </Notice>
        )}

        {repair !== null && (
          <Notice tone="positive" title="Done">
            <p>{repair}</p>
          </Notice>
        )}

        <ListToolbar includeArchived={includeArchived} onIncludeArchivedChange={setIncludeArchived}>
          {years.length > 0 && (
            <Select
              label="Preview in"
              value={year ?? ''}
              hint="The financial year the next numbers are drawn in."
              onChange={(event) => setYear(event.target.value)}
            >
              {years.map((option) => (
                <option key={option.label} value={option.label}>
                  {option.label}
                </option>
              ))}
            </Select>
          )}
        </ListToolbar>

        {series === null ? (
          error === null && <RegisterSkeleton label="numbering series" columns={COLUMNS} />
        ) : (
          <div className="register">
            <table className="ledger-table register__table">
              <thead>
                <tr>
                  <th scope="col">Series</th>
                  <th scope="col">Prefix</th>
                  <th scope="col" className="ledger-table__figure">
                    Width
                  </th>
                  <th scope="col">Next number</th>
                  <th scope="col" className="ledger-table__figure">
                    Next in sequence
                  </th>
                  <th scope="col">Default</th>
                  <th scope="col">
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>

              {groups.map((group) => {
                const warning = groupWarning(group)
                return (
                  <tbody key={group.kind}>
                    <tr className="ledger-table__section">
                      <th scope="rowgroup" colSpan={7}>
                        {group.pluralLabel}
                      </th>
                    </tr>

                    {warning !== null && (
                      <tr className="ledger-table__row--context">
                        <td colSpan={7} className="ledger-table__muted">
                          {warning}
                        </td>
                      </tr>
                    )}

                    {group.series.map((record) => {
                      const preview = previews[record.id]
                      return (
                        <tr
                          key={record.id}
                          className={record.isArchived ? 'ledger-table__row--archived' : undefined}
                        >
                          <td className="register__name">
                            <Button variant="ghost" size="sm" onClick={() => setEditing(record)}>
                              {record.label}
                            </Button>
                            {record.isArchived && (
                              <>
                                {' '}
                                <Badge tone="neutral">Archived</Badge>
                              </>
                            )}
                          </td>
                          {/* A series with no prefix is an ordinary one — a dash rather than
                            a gap that reads as a field somebody forgot to fill in. */}
                          <td className="ledger-table__code">
                            {record.prefix === '' ? '—' : record.prefix}
                          </td>
                          <td className="ledger-table__figure">{record.width}</td>
                          <td className="ledger-table__code">{preview?.preview ?? '—'}</td>
                          <td className="ledger-table__figure">{preview?.nextSequence ?? '—'}</td>
                          <td>
                            {/*
                             * ARCHIVED AND DEFAULT AT ONCE IS A REAL ROW, and it is not the
                             * default. An archived series keeps the flag it went in with as a
                             * record of what it once was — 0007's partial unique index leaves
                             * it out, and `defaultSeriesFor` will not have it — so showing the
                             * badge would tell somebody a new invoice takes a number from a
                             * series that numbers nothing.
                             */}
                            {record.isDefault && !record.isArchived && (
                              <Badge tone="accent">Default</Badge>
                            )}
                          </td>
                          <td className="register__actions">
                            {!record.isArchived && !record.isDefault && (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => void makeDefault(record)}
                              >
                                Make default
                              </Button>
                            )}{' '}
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => void setArchived(record, !record.isArchived)}
                            >
                              {record.isArchived ? 'Restore' : 'Archive'}
                            </Button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                )
              })}
            </table>
          </div>
        )}

        {/*
         * The repair, still offered when nothing is missing.
         *
         * ONE BUTTON, IN ONE OF TWO PLACES. When a kind has none it is the warning at the
         * top of the screen, which is the broken-file case and deserves to be the first
         * thing read; otherwise it is here, quietly, because a company file can be short a
         * kind for a reason nothing on this screen can see and somebody has to be able to
         * ask. Offering both at once would be the same button twice.
         *
         * NOT DANGER STYLING AND NOT BEHIND A CONFIRMATION, in either place. It creates a
         * series for each kind that has none and does nothing else — it cannot take
         * anything away, cannot change a series that is already there and cannot move a
         * counter. Dressing it as dangerous would teach somebody to be afraid of the only
         * thing that fixes a file which can issue nothing at all.
         */}
        {series !== null && missing.length === 0 && (
          <Notice tone="info" title="Missing series">
            <p>
              Every kind needs a series before anything of that kind can be issued. This checks all
              of them and adds only what is missing — nothing already here is changed, and no
              counter moves. Nothing appears to be missing, so this will say so and do nothing,
              which is the ordinary answer on books that have been set up.
            </p>
            <p>
              <Button onClick={() => void runRepair()} isBusy={isRepairing}>
                {REPAIR_LABEL}
              </Button>
            </p>
          </Notice>
        )}
      </div>

      <SeriesDialog
        key={editing === null ? 'closed' : editing === 'new' ? 'new' : editing.id}
        isOpen={editing !== null}
        record={editing === 'new' ? null : editing}
        preview={editing === null || editing === 'new' ? undefined : previews[editing.id]}
        year={year}
        onClose={() => setEditing(null)}
        onSaved={(saved, wasNew) => {
          setEditing(null)
          void announceSave(saved, wasNew)
          void load()
        }}
      />
    </ScreenFrame>
  )
}

/** 'Refunds paid and Refunds received'. The words come off the kind tables. */
function listKinds(labels: readonly string[]): string {
  if (labels.length <= 1) return labels[0] ?? ''
  return `${labels.slice(0, -1).join(', ')} and ${labels.at(-1) ?? ''}`
}

// ---- Adding and editing ----------------------------------------------------

interface SeriesDialogProps {
  isOpen: boolean
  /** Null when adding. */
  record: NumberingSeriesRecord | null
  /** What the series produces next, as main last answered. Absent while adding. */
  preview: NumberPreview | undefined
  /** The year the preview above was drawn in, so the editor can say which it was. */
  year: string | null
  onClose: () => void
  onSaved: (record: NumberingSeriesRecord, wasNew: boolean) => void
}

/**
 * One dialog for adding and for editing.
 *
 * THE KIND IS CHOSEN ONCE. `UpdateNumberingSeriesInput` has no `kind` field because
 * moving a series to another kind would renumber every document already issued under it,
 * so the picker is offered while creating and the kind is stated as a fact afterwards.
 *
 * THE WHOLE SHAPE IS POSTED BACK ON AN UPDATE, which is what the boundary expects:
 * `shapeChangesIn` compares by VALUE, so re-sending the prefix a series already has is
 * not a change to it. That is what keeps the default flag editable on a series that has
 * already numbered something.
 *
 * WHAT IS NOT DECIDED HERE. Whether the width is within bounds, whether the label clashes
 * with another series of the same kind, and whether a shape may still be changed at all
 * are main's questions, each with a sentence written for the user — `SERIES_WIDTH_INVALID`,
 * `SERIES_LABEL_TAKEN`, `SERIES_IN_USE`. The only thing refused here is a width that is
 * not a number, which is a parse and not a rule: there is nothing to send.
 */
function SeriesDialog({
  isOpen,
  record,
  preview,
  year,
  onClose,
  onSaved,
}: SeriesDialogProps): JSX.Element {
  const isNew = record === null

  const [label, setLabel] = useState(record?.label ?? '')
  /* Empty until chosen. A picker defaulted to the first kind is one somebody saves
   * without reading, and a series on the wrong kind cannot be moved afterwards. */
  const [kind, setKind] = useState(record?.kind ?? '')
  const [prefix, setPrefix] = useState(record?.prefix ?? '')
  const [separator, setSeparator] = useState(record?.separator ?? '')
  const [suffix, setSuffix] = useState(record?.suffix ?? '')
  const [width, setWidth] = useState(record === null ? '' : String(record.width))
  const [includeFiscalYear, setIncludeFiscalYear] = useState(record?.includeFiscalYear ?? false)
  /*
   * '' means "say nothing about it", and on a new series that is main answering from the
   * kind's own `resetsYearly` — an invoice restarts each year, a quotation runs on. Naming
   * that rule here would be a second copy of it, kept in step by nobody.
   */
  const [resetOn, setResetOn] = useState<string>(record?.resetOn ?? '')
  const [isDefault, setDefault] = useState(record?.isDefault ?? false)

  const [isBusy, setBusy] = useState(false)
  const [error, setError] = useState<AppError | null>(null)

  /* Blank is a legitimate answer and means "do not send it": main uses its own width on a
   * new series and leaves an existing one alone. Anything that is not a whole number is
   * not an answer at all, and there is nothing to send for it. */
  const trimmedWidth = width.trim()
  const parsedWidth = trimmedWidth === '' ? undefined : Number(trimmedWidth)
  /* Only "is this a number at all". The RANGE is main's — `SERIES_WIDTH_INVALID` names
   * the bounds and repeats the value back — and a second, weaker copy of it here would
   * either disagree with main or say the same thing twice. A width of -1 is sent and
   * refused in main's words; 'abc' is not sent because there is nothing to send. */
  const isWidthReadable = parsedWidth === undefined || Number.isInteger(parsedWidth)

  const canSubmit = label.trim() !== '' && kind !== '' && isWidthReadable && !isBusy

  const submit = useCallback(async () => {
    if (!canSubmit) return
    setBusy(true)
    setError(null)

    /*
     * Every shape field, every time. Written out rather than spread so that a field added
     * to the DTO and not to this form fails to compile rather than quietly stopping being
     * sent — the same rule CompanyProfile states for a profile, for a weaker reason: an
     * update is a patch here, so a missing field is stale rather than cleared.
     */
    const shape = {
      label: label.trim(),
      prefix,
      separator,
      suffix,
      includeFiscalYear,
      isDefault,
      /* Undefined rather than omitted, which the boundary reads the same way: `optional`
       * treats an undefined field as absent. Blank says nothing about the width, and on
       * a new series that is main using its own. */
      width: parsedWidth,
      resetOn: resetOn === '' ? undefined : (resetOn as NumberingReset),
    }

    const result = await callApi((api) =>
      record === null
        ? api.numbering.create({ ...shape, kind } satisfies CreateNumberingSeriesInput)
        : api.numbering.update({ ...shape, id: record.id } satisfies UpdateNumberingSeriesInput),
    )
    setBusy(false)

    if (!result.ok) {
      setError(result.error)
      return
    }
    onSaved(result.data, record === null)
  }, [
    canSubmit,
    includeFiscalYear,
    isDefault,
    kind,
    label,
    onSaved,
    parsedWidth,
    prefix,
    record,
    resetOn,
    separator,
    suffix,
  ])

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      title={isNew ? 'New series' : `Edit ${record.label}`}
      description="Every part of a number is yours to set, so a series can keep looking the way it already looks."
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

        {record !== null && record.hasIssued && (
          <Notice tone="info" title="This series has numbered a document">
            <p>
              Its shape is fixed from here — changing a prefix or a width after{' '}
              {preview === undefined ? 'a number has been issued' : preview.preview} exists would
              produce a second series that looks like a continuation of the first and is not. The
              label and the default can still be changed. For a new shape, add a new series.
            </p>
          </Notice>
        )}

        <Input
          label="Label"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          hint="What this series is called when a kind has more than one — 'Main', 'Export', 'Branch — Coimbatore'. It is not printed on anything."
        />

        {record === null ? (
          <Select
            label="Numbers"
            value={kind}
            onChange={(event) => setKind(event.target.value)}
            hint="Which kind of document or voucher takes its numbers from this series. It cannot be changed afterwards — a series that moved would renumber everything already issued under it."
          >
            <option value="">Choose one</option>
            {NUMBERED_KINDS.map((option) => (
              <option key={option.kind} value={option.kind}>
                {option.label}
              </option>
            ))}
          </Select>
        ) : (
          <p className="prose prose--muted">
            Numbers {numberedKindLabel(record.kind).toLowerCase()}. A series cannot be moved to
            another kind — everything already issued under it carries its numbers.
          </p>
        )}

        <Input
          label="Prefix"
          isIdentifier
          value={prefix}
          onChange={(event) => setPrefix(event.target.value)}
          hint="What comes before the number, e.g. INV. Left exactly as typed — a trailing space is somebody's format, not a mistake."
        />

        <Input
          label="Separator"
          isIdentifier
          value={separator}
          onChange={(event) => setSeparator(event.target.value)}
          hint="What joins the parts, e.g. / or -. Leave it empty for a number that runs on, like INV0042."
        />

        <Input
          label="Suffix"
          isIdentifier
          value={suffix}
          onChange={(event) => setSuffix(event.target.value)}
          hint="What comes after the number. Usually nothing."
        />

        <Input
          label="Width"
          value={width}
          onChange={(event) => setWidth(event.target.value)}
          inputMode="numeric"
          error={isWidthReadable ? undefined : 'A width is a whole number of digits, or nothing.'}
          hint="How many digits the count is padded to: 4 gives 0001. A count that outgrows it gets longer rather than starting again. Leave it empty to take the standard width."
        />

        <CheckboxField
          isChecked={includeFiscalYear}
          onChange={setIncludeFiscalYear}
          hint="Puts the year between the prefix and the count, as in INV/2026-27/0001."
        >
          Show the financial year in the number
        </CheckboxField>

        <Select
          label="Counting"
          value={resetOn}
          onChange={(event) => setResetOn(event.target.value)}
          hint="Restarting each year is what a tax invoice usually does. This is separate from showing the year: a series can restart without printing it, or print it and count on."
        >
          {record === null && <option value="">Whatever suits this kind</option>}
          {RESET_OPTIONS.map((option) => (
            <option key={option} value={option}>
              {RESET_LABELS[option]}
            </option>
          ))}
        </Select>

        <CheckboxField
          isChecked={isDefault}
          onChange={setDefault}
          hint="One series per kind is the default. Without one, nothing of that kind can be issued at all."
        >
          Take new numbers of this kind from this series
        </CheckboxField>

        {/*
         * WHAT IT PRODUCES, ASKED OF MAIN. There is nothing to ask about a series that
         * does not exist yet — `numbering.preview` takes an id — and saying so is better
         * than drawing a number here that the code which issues one has never seen.
         */}
        <div className="fact">
          <span className="fact__label">Next number</span>
          {record === null ? (
            <p className="prose prose--muted">
              Shown once the series is saved. It comes from the same code that numbers a real
              document, so it is what will actually print.
            </p>
          ) : preview === undefined ? (
            <p className="prose prose--muted">
              {needsFiscalYear(record) && year === null
                ? 'These books have no financial year to draw this series in, so its next number cannot be worked out.'
                : 'Not available.'}
            </p>
          ) : (
            <p className="prose selectable">
              {preview.preview}
              {needsFiscalYear(record) && year !== null ? ` — in ${year}` : ''}
            </p>
          )}
        </div>
      </div>
    </Dialog>
  )
}

registerScreens([
  {
    id: 'numbering',
    title: 'Numbering',
    area: 'workspace',
    nav: { label: 'Numbering', icon: 'hash', group: 'company', order: 1 },
    render: () => <Numbering />,
  },
])
