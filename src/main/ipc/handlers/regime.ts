/*
 * The `regime` group.
 *
 * The smallest handler in the application: one method, no arguments, no validation to do.
 * `parseArgs` returns an empty tuple exactly as `companyProfile.get` does — a method that
 * takes nothing must be *proved* to take nothing, because the registry hands `parseArgs`
 * whatever the renderer sent and a handler that ignored it would pass anything through.
 *
 * There is no `describe(regimeId)`. A screen cannot ask about a regime other than the one
 * its books were set up under, and offering the choice would invite a picker built from
 * one regime's rates against another regime's tax.
 */

import type { RegimeDescription } from '../../../shared/dto'
import type { GroupHandlers } from '../registry'
import { ok } from '../surface'

/**
 * What the IPC layer needs from src/main/regime.
 *
 * One method per contract method, same name, same DTO, no envelope.
 */
export interface RegimeService {
  describe(): Promise<RegimeDescription>
}

export function createRegimeHandlers(service: RegimeService): GroupHandlers<'regime'> {
  return {
    describe: {
      parseArgs: (): [] => [],
      handle: async () => ok(await service.describe()),
    },
  }
}
