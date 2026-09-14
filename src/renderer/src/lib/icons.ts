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
  people:
    'M9 11.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20c0-3.3 2.9-5.5 6.5-5.5s6.5 2.2 6.5 5.5M16.5 5.2a3.5 3.5 0 0 1 0 6.6M18 14.9c2.1.6 3.5 2.2 3.5 4.4',
  truck:
    'M2.5 6.5h11V16h-11zM13.5 9.5H18l3 3V16h-7.5M7 19a1.8 1.8 0 1 0 0-3.6A1.8 1.8 0 0 0 7 19zM17.5 19a1.8 1.8 0 1 0 0-3.6 1.8 1.8 0 0 0 0 3.6z',
  refresh: 'M20 12a8 8 0 1 1-2.4-5.7M20.5 4v5h-5',

  /*
   * One per screen in the rail. Collapsed, the rail is these and nothing else, so no two
   * screens in one section may share a glyph (ContextRail.test.tsx walks the registry for
   * it). Documents are a page with a mark saying which; money moves in or out of a tray.
   */
  overview: 'M3.5 3.5h7v7h-7zM13.5 3.5h7v4h-7zM13.5 10.5h7v10h-7zM3.5 13.5h7v7h-7z',
  accounts: 'M4.5 4.5h4v4h-4zM6.5 8.5V19h4.5M6.5 13.5h4.5M13.5 13.5h6M13.5 19h6M11.5 6.5h8',
  calendar: 'M4 5.5h16V20H4zM4 10h16M8.5 3.5v4M15.5 3.5v4M8 14h2M14 14h2',
  scale: 'M12 4v16M8 20h8M5 7h14M5 7l-2.5 6h5zM19 7l-2.5 6h5z',
  columns: 'M4 4.5h16v15H4zM12 4.5v15M6.5 8.5h3M14.5 8.5h3M6.5 12h3M14.5 12h3',
  trend: 'M3.5 17l5.5-5.5 4 4 7.5-7.5M15 8h5.5v5.5',
  invoice: 'M6 3h8.5L19 7.5V21H6zM14 3v5h5M9 12h7M9 15.5h7',
  quotation: 'M6 3h8.5L19 7.5V21H6zM14 3v5h5M9.5 14h.01M12.5 14h.01M15.5 14h.01',
  'note-minus': 'M6 3h8.5L19 7.5V21H6zM14 3v5h5M9.5 14h6',
  'note-plus': 'M6 3h8.5L19 7.5V21H6zM14 3v5h5M9.5 14h6M12.5 11v6',
  bill: 'M6 3h12v18l-2-1.5-2 1.5-2-1.5-2 1.5-2-1.5-2 1.5zM9 8h6M9 11.5h6M9 15h4',
  'money-in': 'M12 3.5v11M7.5 10l4.5 4.5 4.5-4.5M4 15.5V20h16v-4.5',
  'money-out': 'M12 14.5v-11M7.5 8L12 3.5 16.5 8M4 15.5V20h16v-4.5',
  refund: 'M9 5.5L4.5 10 9 14.5M4.5 10H15a4.5 4.5 0 0 1 0 9h-3',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3.5 2',
  box: 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM4 7.5l8 4.5 8-4.5M12 12v9',
  ruler: 'M3.5 16.5l13-13 4 4-13 13zM7.5 12.5l2 2M10.5 9.5l2 2M13.5 6.5l2 2',
  hash: 'M9.5 3.5l-2 17M16.5 3.5l-2 17M4.5 9h16M3.5 15h16',
  question:
    'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.6 9.4a2.5 2.5 0 1 1 3.4 2.4c-.6.3-1 .9-1 1.6v.4M12 17h.01',
} as const

export type IconName = keyof typeof ICON_PATHS

export function isIconName(value: unknown): value is IconName {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(ICON_PATHS, value)
}
