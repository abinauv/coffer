/*
 * Parties as palette results (Screens §04): type part of a firm's name and open it.
 *
 * READ WHEN THE PALETTE OPENS, AND ONLY THEN. `parties.list` has no limit and answers with
 * every party there is, so holding it for the life of the workspace would pull the whole
 * master on every company open to say nothing. Opening the palette is the moment somebody
 * might look for one, and the list is dropped again when it closes.
 *
 * SEARCH-ONLY. A result is not a command worth listing: five hundred customers under an
 * empty query would bury every command in the palette, so these appear once something has
 * been typed (`Command.isSearchOnly`).
 *
 * WHERE ONE OPENS. A party that sells to the business opens under Vendors, anything else
 * under Customers; either list opens the same record, because one record covers both sides.
 */

import { useEffect, useMemo, useState } from 'react'
import type { JSX } from 'react'
import { callApi } from '@renderer/lib/api'
import type { Command } from '@renderer/lib/command-registry'
import { makeRoute } from '@renderer/lib/routing'
import { useCommands, useRegisterCommands } from '@renderer/store/commands'
import { useCompany } from '@renderer/store/company'
import { useNavigation } from '@renderer/store/navigation'
import type { PartySummary } from '@shared/dto'
import { partyKindLabel } from '../lib/party-view'

export function PartySearch(): JSX.Element {
  const { company } = useCompany()
  const { isPaletteOpen } = useCommands()
  const { navigate } = useNavigation()
  const [parties, setParties] = useState<readonly PartySummary[]>([])

  const isLooking = isPaletteOpen && company !== null

  useEffect(() => {
    if (!isLooking) return
    let current = true
    void callApi((api) => api.parties.list()).then((result) => {
      if (current && result.ok) setParties(result.data)
    })
    return () => {
      current = false
    }
  }, [isLooking])

  useRegisterCommands(
    useMemo<Command[]>(
      () =>
        isLooking
          ? parties.map((party) => ({
              id: `parties.open.${party.id}`,
              title: party.name,
              section: 'Parties',
              location: [partyKindLabel(party), party.city].filter(Boolean).join(' · '),
              keywords: [party.registrationNumber ?? '', party.city ?? ''].filter(
                (word) => word !== '',
              ),
              isSearchOnly: true,
              run: () =>
                navigate(
                  makeRoute(
                    'workspace',
                    party.isVendor && !party.isCustomer ? 'vendors' : 'customers',
                    { id: party.id },
                  ),
                ),
            }))
          : [],
      [isLooking, navigate, parties],
    ),
  )

  return <></>
}
