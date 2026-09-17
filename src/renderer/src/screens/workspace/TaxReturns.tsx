/*
 * Reports → Tax returns.
 *
 * WHAT THIS SCREEN IS NOT: a filing. Coffer does not talk to any tax authority and never
 * will from here. The screen shows what a return prepared from these books would say,
 * table by table, and writes a file the user can check. Every word that names a form or a
 * table — and every figure — comes from main; nothing here knows which country's return it
 * is drawing (CONVENTIONS §1.6).
 *
 * PROVISIONAL IS SAID TWICE, ON PURPOSE. A badge beside the title, because it is a status,
 * and the regime's own notice above the table, because the badge alone does not say what
 * is unverified. The arithmetic is exact; the shape has not been checked against the
 * authority's schema, and somebody about to upload a file needs to be told which of those
 * two things they are relying on.
 *
 * OPENING A RETURN IS REMEMBERED, so the Overview can stop mentioning it. That is recorded
 * after the table has been drawn and not before — a return that failed to prepare has not
 * been looked at.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { JSX } from 'react'
import { Badge, Button, Select } from '@renderer/components/atoms'
import { callApi } from '@renderer/lib/api'
import type { Command } from '@renderer/lib/command-registry'
import { registerScreens } from '@renderer/lib/screens'
import { todayISO } from '@renderer/lib/today'
import { useRegisterCommands } from '@renderer/store/commands'
import { useNumberFormat, useRegime } from '@renderer/store/regime'
import { useToasts } from '@renderer/store/toasts'
import type { AccountingPeriod, AppError, TaxReturn } from '@shared/dto'
import { EmptyState } from '../components/EmptyState'
import { FailureNotice } from '../components/FailureNotice'
import { Notice } from '../components/Notice'
import { RegisterSkeleton, type SkeletonColumn } from '../components/RegisterSkeleton'
import { ScreenFrame } from '../components/ScreenFrame'
import { formatAmount } from '../lib/ledger-format'
import {
  defaultPeriod,
  groupIssues,
  issueSummary,
  periodOptions,
  requestedPeriod,
} from '../lib/tax-return-view'

const COLUMNS: readonly SkeletonColumn[] = [
  { width: '6rem' },
  { width: '1fr' },
  { width: '5rem', align: 'end' },
  { width: '9rem', align: 'end' },
  { width: '9rem', align: 'end' },
]

interface TaxReturnsProps {
  /** What a link from the Overview asked for. Ignored where it names nothing on offer. */
  requested?: { form?: string; from?: string; to?: string }
}

export function TaxReturns({ requested = {} }: TaxReturnsProps): JSX.Element {
  const regime = useRegime()
  const format = useNumberFormat()
  const { show } = useToasts()

  const forms = regime?.returnForms ?? []
  const [periods, setPeriods] = useState<readonly AccountingPeriod[] | null>(null)
  const [formId, setFormId] = useState<string>('')
  const [periodValue, setPeriodValue] = useState<string>('')
  const [prepared, setPrepared] = useState<TaxReturn | null>(null)
  const [error, setError] = useState<AppError | null>(null)
  const [isBusy, setBusy] = useState(false)
  const [isExporting, setExporting] = useState(false)

  const today = todayISO()
  const options = useMemo(
    () => (periods === null ? [] : periodOptions(periods, today)),
    [periods, today],
  )
  const period = options.find((option) => option.value === periodValue) ?? null

  useEffect(() => {
    void callApi((api) => api.ledger.listPeriods()).then((result) => {
      if (result.ok) setPeriods(result.data)
      else setError(result.error)
    })
  }, [])

  /* The first choice: what a link asked for when it is on offer, otherwise the first form
   * and the latest finished period. Made once, when both lists have arrived. */
  useEffect(() => {
    if (formId === '' && forms.length > 0) {
      const asked = forms.find((form) => form.id === requested.form)
      setFormId((asked ?? forms[0])?.id ?? '')
    }
  }, [forms, formId, requested.form])

  useEffect(() => {
    if (periodValue === '' && options.length > 0) {
      const chosen =
        requestedPeriod(options, requested.from, requested.to) ?? defaultPeriod(options, today)
      if (chosen !== null) setPeriodValue(chosen.value)
    }
  }, [options, periodValue, requested.from, requested.to, today])

  const load = useCallback(async () => {
    if (formId === '' || period === null) return
    setBusy(true)
    const input = { formId, from: period.from, to: period.to }
    const result = await callApi((api) => api.reports.taxReturn(input))
    setBusy(false)
    if (!result.ok) {
      setPrepared(null)
      setError(result.error)
      return
    }
    setError(null)
    setPrepared(result.data)
    /* Looked at now that it is on screen. A failure to remember it changes nothing the user
     * can see here, so it is not reported — the Overview will simply mention it again. */
    void callApi((api) => api.reports.markTaxReturnSeen(input))
  }, [formId, period])

  useEffect(() => {
    void load()
  }, [load])

  const exportFile = useCallback(async () => {
    if (formId === '' || period === null) return
    setExporting(true)
    const result = await callApi((api) =>
      api.reports.exportTaxReturn({ formId, from: period.from, to: period.to }),
    )
    setExporting(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    /* A closed save dialog is the user's own decision and not news. */
    if (result.data.path === null) return
    show({ tone: 'success', title: 'Return exported', body: result.data.path })
  }, [formId, period, show])

  useRegisterCommands(
    useMemo<Command[]>(
      () =>
        forms.length === 0
          ? []
          : [
              {
                id: 'reports.tax-returns-export',
                title: 'Export this return as a file',
                section: 'Reports',
                keywords: ['return', 'json', 'file', 'tax'],
                isDisabled: prepared === null,
                run: () => void exportFile(),
              },
            ],
      [exportFile, forms.length, prepared],
    ),
  )

  if (regime !== null && forms.length === 0) {
    return (
      <ScreenFrame isInset width="list" title="Tax returns">
        <EmptyState title="Nothing to prepare" titleAs="h2">
          <p>The tax rules these books follow do not prepare any returns in Coffer.</p>
        </EmptyState>
      </ScreenFrame>
    )
  }

  const issues = prepared === null ? null : groupIssues(prepared.issues)

  return (
    <ScreenFrame
      isInset
      width="list"
      title="Tax returns"
      lede="What a return prepared from your issued documents would say. Coffer files nothing — it shows the figures and writes a file you can check."
      actions={
        <Button
          icon="archive"
          disabled={prepared === null}
          isBusy={isExporting}
          onClick={() => void exportFile()}
        >
          Export as a file
        </Button>
      }
    >
      <div className="stack">
        <div className="toolbar">
          <Select label="Return" value={formId} onChange={(event) => setFormId(event.target.value)}>
            {forms.map((form) => (
              <option key={form.id} value={form.id}>
                {form.label}
              </option>
            ))}
          </Select>
          <Select
            label="Period"
            value={periodValue}
            onChange={(event) => setPeriodValue(event.target.value)}
          >
            {options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </div>

        {error && <FailureNotice error={error} context="ledger" />}

        {prepared === null ? (
          error === null && <RegisterSkeleton label="the return" columns={COLUMNS} />
        ) : (
          <>
            <div className="stack stack--tight">
              <h2 className="returns__title">
                {prepared.form.label} · {prepared.period.label}
                {prepared.isProvisional && <Badge tone="warning">Provisional</Badge>}
              </h2>
              <p className="prose prose--muted">{prepared.form.description}</p>
            </div>

            {prepared.isProvisional && prepared.notice !== null && (
              <Notice tone="warning" title="Check the layout before you upload anything">
                <p>{prepared.notice}</p>
              </Notice>
            )}

            <div className="register" aria-busy={isBusy}>
              <table className="ledger-table ledger-table--figures register__table">
                <thead>
                  <tr>
                    <th scope="col">Table</th>
                    <th scope="col">What it holds</th>
                    <th scope="col" className="ledger-table__figure">
                      Documents
                    </th>
                    <th scope="col" className="ledger-table__figure">
                      Taxable value
                    </th>
                    <th scope="col" className="ledger-table__figure">
                      Tax
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {prepared.rows.map((row) => (
                    <tr key={row.id} className="ledger-table__row">
                      <td className="returns__table">{row.label}</td>
                      <td>{row.what}</td>
                      <td className="ledger-table__figure">
                        {row.documentCount === null ? '—' : row.documentCount}
                      </td>
                      <td className="ledger-table__figure">
                        {row.taxableValue === null ? '—' : formatAmount(row.taxableValue, format)}
                      </td>
                      <td className="ledger-table__figure">{formatAmount(row.tax, format)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="ledger-table__total">
                    <td colSpan={2}>{prepared.total.label}</td>
                    <td className="ledger-table__figure">
                      {prepared.total.documentCount === null ? '' : prepared.total.documentCount}
                    </td>
                    <td className="ledger-table__figure">
                      {prepared.total.taxableValue === null
                        ? ''
                        : formatAmount(prepared.total.taxableValue, format)}
                    </td>
                    <td className="ledger-table__figure">
                      {formatAmount(prepared.total.tax, format)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>

            <section className="stack stack--tight" aria-labelledby="before-you-file">
              <h2 className="caps-label" id="before-you-file">
                Before you file
              </h2>
              <p className="prose">{issueSummary(prepared.issues)}</p>
              {issues !== null && issues.errors.length + issues.warnings.length > 0 && (
                <ul className="returns__issues">
                  {[...issues.errors, ...issues.warnings].map((issue, index) => (
                    <li key={`${issue.code}-${index}`} className="returns__issue">
                      <Badge tone={issue.severity === 'error' ? 'negative' : 'neutral'}>
                        {issue.severity === 'error' ? 'Must fix' : 'Assumed'}
                      </Badge>
                      <span>
                        {issue.documentNumber !== null && (
                          <span className="returns__document">{issue.documentNumber} · </span>
                        )}
                        {issue.message}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </div>
    </ScreenFrame>
  )
}

registerScreens([
  {
    id: 'tax-returns',
    title: 'Tax returns',
    area: 'workspace',
    nav: { label: 'Tax returns', icon: 'invoice', group: 'reports', order: 3 },
    render: ({ route }) => (
      <TaxReturns
        requested={{
          ...(route.params['form'] === undefined ? {} : { form: route.params['form'] }),
          ...(route.params['from'] === undefined ? {} : { from: route.params['from'] }),
          ...(route.params['to'] === undefined ? {} : { to: route.params['to'] }),
        }}
      />
    ),
  },
])
