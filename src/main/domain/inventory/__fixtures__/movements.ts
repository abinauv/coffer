/*
 * Builders for the tests beside this folder.
 *
 * A movement has eight fields and most tests care about two of them, so writing them out
 * every time would bury the case being made. Nothing here decides anything: no defaults
 * that could stand in for a rule, no arithmetic, and every field a test needs to vary is
 * overridable.
 */

import { D } from '@main/domain/money'
import type { BatchRef, StockLayer, StockMovement, StockMovementKind } from '../types'

export interface MovementSpec {
  kind: StockMovementKind
  quantity: string
  cost?: string | null
  date?: string
  sequence?: number
  itemId?: string
  layerKey?: string | null
  batch?: BatchRef | null
}

export const TEST_ITEM = 'item-widget'

export function movementOf(spec: MovementSpec): StockMovement {
  const cost = spec.cost
  return {
    itemId: spec.itemId ?? TEST_ITEM,
    kind: spec.kind,
    date: spec.date ?? '2026-06-01',
    sequence: spec.sequence ?? 1,
    quantity: D(spec.quantity),
    cost: cost === undefined || cost === null ? null : D(cost),
    layerKey: spec.layerKey ?? null,
    batch: spec.batch ?? null,
  }
}

export interface LayerSpec {
  key: string
  quantity: string
  value: string
  receivedAt?: string | null
  sequence?: number | null
  batch?: BatchRef | null
}

export function layerOf(spec: LayerSpec): StockLayer {
  return {
    key: spec.key,
    quantity: D(spec.quantity),
    value: D(spec.value),
    receivedAt: spec.receivedAt ?? null,
    sequence: spec.sequence ?? null,
    batch: spec.batch ?? null,
  }
}
