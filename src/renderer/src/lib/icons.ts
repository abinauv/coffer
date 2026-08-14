/*
 * The icon set, as path data.
 *
 * Inline rather than from a package: the CSP forbids remote origins, an icon
 * library is a dependency this batch may not add, and a shell needs perhaps two
 * dozen glyphs. All are drawn on a 24×24 grid as open strokes in `currentColor`,
 * so they inherit weight and colour from whatever they sit in.
 *
 * Kept as data in `lib/` rather than as markup in the component so the icon name
 * is a type that modules outside `components/` — the screen registry, the command
 * registry — can refer to without importing React.
 */

export const ICON_PATHS = {
  /* Navigation and disclosure */
  'chevron-up': 'M6 15l6-6 6 6',
  'chevron-down': 'M6 9l6 6 6-6',
  'chevron-left': 'M15 6l-6 6 6 6',
  'chevron-right': 'M9 6l6 6-6 6',
  'arrow-right': 'M4 12h15M13 6l6 6-6 6',
  'corner-down-left': 'M20 5v6a3 3 0 0 1-3 3H5M9 10l-4 4 4 4',
  close: 'M6 6l12 12M18 6L6 18',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  check: 'M20 6.5L9.5 17 4 11.5',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3',

  /* Status */
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5M12 8h.01',
  'check-circle': 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM8.2 12.3l2.6 2.6L16 9.6',
  'alert-triangle': 'M12 4.2l8.8 15.3H3.2zM12 10v4M12 17h.01',
  'alert-circle': 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7.5v5M12 16h.01',

  /* Theme */
  sun: 'M12 16.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9zM12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4',
  moon: 'M20.5 14.6A8.6 8.6 0 0 1 9.4 3.5a8.6 8.6 0 1 0 11.1 11.1z',
  monitor: 'M3.5 5h17v10.5h-17zM9 20h6M12 15.5V20',

  /* Shell and domain */
  'panel-left': 'M3.5 5h17v14h-17zM9.5 5v14',
  ledger: 'M5 4.5a1.5 1.5 0 0 1 1.5-1.5H19v18H6.5A1.5 1.5 0 0 1 5 19.5zM5 17.5h14M9 7.5h6M9 11h6',
  building: 'M4 21V4.5h10V21M4 21h16M14 21V10h6v11M7 8h4M7 12h4M7 16h4',
  settings: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 4.5v5M9 14.5v5',
  lock: 'M6 10.5h12V20H6zM9 10.5V7.5a3 3 0 0 1 6 0v3',
  folder: 'M3.5 6.5h6l2 2.5h9V19h-17z',
  archive: 'M3.5 4.5h17V9h-17zM5 9v10.5h14V9M10 12.5h4',
  refresh: 'M20 12a8 8 0 1 1-2.4-5.7M20.5 4v5h-5',
  question:
    'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.6 9.4a2.5 2.5 0 1 1 3.4 2.4c-.6.3-1 .9-1 1.6v.4M12 17h.01',
} as const

export type IconName = keyof typeof ICON_PATHS

export function isIconName(value: unknown): value is IconName {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(ICON_PATHS, value)
}
