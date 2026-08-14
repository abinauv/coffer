import { describe, expect, it, vi } from 'vitest'
import {
  createCommandRegistry,
  groupMatches,
  scoreText,
  searchCommands,
  type Command,
} from './command-registry'

function command(id: string, title: string, extra: Partial<Command> = {}): Command {
  return { id, title, section: 'Test', run: () => {}, ...extra }
}

describe('createCommandRegistry', () => {
  it('starts empty', () => {
    expect(createCommandRegistry().list()).toEqual([])
  })

  it('lists what was registered', () => {
    const registry = createCommandRegistry()
    registry.register([command('a', 'Alpha'), command('b', 'Bravo')])
    expect(registry.list().map((entry) => entry.id)).toEqual(['a', 'b'])
  })

  it('removes exactly the commands of the returned disposer', () => {
    const registry = createCommandRegistry()
    registry.register([command('a', 'Alpha')])
    const unregister = registry.register([command('b', 'Bravo')])
    unregister()
    expect(registry.list().map((entry) => entry.id)).toEqual(['a'])
  })

  it('is idempotent when a disposer runs twice', () => {
    const registry = createCommandRegistry()
    const unregister = registry.register([command('a', 'Alpha')])
    unregister()
    unregister()
    expect(registry.list()).toEqual([])
  })

  /* StrictMode mounts, unmounts and remounts. The second registration arrives
   * before the first is disposed, so the id is momentarily registered twice. */
  it('collapses a duplicate id to the newest registration', () => {
    const registry = createCommandRegistry()
    const first = registry.register([command('a', 'Old title')])
    registry.register([command('a', 'New title')])

    expect(registry.list()).toHaveLength(1)
    expect(registry.list()[0]?.title).toBe('New title')

    first()
    expect(registry.list()).toHaveLength(1)
    expect(registry.list()[0]?.title).toBe('New title')
  })

  it('finds a command by id', () => {
    const registry = createCommandRegistry()
    registry.register([command('a', 'Alpha')])
    expect(registry.find('a')?.title).toBe('Alpha')
    expect(registry.find('missing')).toBeUndefined()
  })

  /* useSyncExternalStore loops forever if the snapshot identity changes on every
   * read, so this is a correctness requirement rather than an optimisation. */
  it('returns a stable snapshot until something changes', () => {
    const registry = createCommandRegistry()
    registry.register([command('a', 'Alpha')])
    const first = registry.list()
    expect(registry.list()).toBe(first)

    registry.register([command('b', 'Bravo')])
    expect(registry.list()).not.toBe(first)
  })

  it('notifies subscribers on register and unregister, and stops after unsubscribe', () => {
    const registry = createCommandRegistry()
    const listener = vi.fn()
    const unsubscribe = registry.subscribe(listener)

    const unregister = registry.register([command('a', 'Alpha')])
    expect(listener).toHaveBeenCalledTimes(1)

    unregister()
    expect(listener).toHaveBeenCalledTimes(2)

    unsubscribe()
    registry.register([command('c', 'Charlie')])
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('copies the caller array so later mutation cannot reach the registry', () => {
    const registry = createCommandRegistry()
    const commands = [command('a', 'Alpha')]
    registry.register(commands)
    commands.push(command('b', 'Bravo'))
    expect(registry.list()).toHaveLength(1)
  })
})

describe('searchCommands', () => {
  const commands = [
    command('journal', 'New journal entry', { keywords: ['posting', 'ledger'] }),
    command('invoice', 'New sales invoice'),
    command('backup', 'Back up this company', { section: 'Company' }),
    command('close', 'Close company', { section: 'Company' }),
  ]

  it('returns everything in registration order for an empty query', () => {
    expect(searchCommands(commands, '').map((match) => match.command.id)).toEqual([
      'journal',
      'invoice',
      'backup',
      'close',
    ])
    expect(searchCommands(commands, '   ').map((match) => match.command.id)).toEqual([
      'journal',
      'invoice',
      'backup',
      'close',
    ])
  })

  it('drops commands the query does not reach', () => {
    expect(searchCommands(commands, 'zzz')).toEqual([])
  })

  it('is case insensitive', () => {
    expect(searchCommands(commands, 'JOURNAL')[0]?.command.id).toBe('journal')
  })

  it('ranks a prefix above a mid-word match', () => {
    const ranked = searchCommands(commands, 'clo')
    expect(ranked[0]?.command.id).toBe('close')
  })

  it('finds a command through its keywords', () => {
    const ranked = searchCommands(commands, 'posting')
    expect(ranked.map((match) => match.command.id)).toEqual(['journal'])
  })

  it('ranks a title match above an equally good keyword match', () => {
    const withKeyword = [
      command('a', 'Something else', { keywords: ['backup'] }),
      command('b', 'Backup now'),
    ]
    expect(searchCommands(withKeyword, 'backup')[0]?.command.id).toBe('b')
  })

  it('matches a scattered subsequence', () => {
    const ranked = searchCommands(commands, 'njl')
    expect(ranked[0]?.command.id).toBe('journal')
  })

  it('rejects a subsequence whose characters are out of order', () => {
    expect(searchCommands([command('a', 'New journal entry')], 'lj')).toEqual([])
  })

  it('breaks ties by registration order', () => {
    const tied = [command('first', 'Report'), command('second', 'Report')]
    expect(searchCommands(tied, 'Report').map((match) => match.command.id)).toEqual([
      'first',
      'second',
    ])
  })

  it('reports ranges that cover the matched characters of the title', () => {
    const [match] = searchCommands([command('a', 'Close company')], 'comp')
    expect(match?.ranges).toEqual([[6, 10]])
  })
})

describe('scoreText', () => {
  it('is null when the query is absent', () => {
    expect(scoreText('Close company', 'zzz')).toBeNull()
  })

  it('scores a prefix highest, then a word start, then a mid-word hit', () => {
    const prefix = scoreText('Close company', 'clo')?.score ?? 0
    const wordStart = scoreText('Close company', 'com')?.score ?? 0
    const midWord = scoreText('Close company', 'ompa')?.score ?? 0
    expect(prefix).toBeGreaterThan(wordStart)
    expect(wordStart).toBeGreaterThan(midWord)
  })

  it('rewards adjacent characters over scattered ones', () => {
    const adjacent = scoreText('backup archive', 'back')?.score ?? 0
    const scattered = scoreText('backup archive', 'bkar')?.score ?? 0
    expect(adjacent).toBeGreaterThan(scattered)
  })
})

describe('groupMatches', () => {
  it('keeps sections in first-appearance order and preserves rank inside them', () => {
    const matches = searchCommands(
      [
        command('a', 'Alpha', { section: 'One' }),
        command('b', 'Bravo', { section: 'Two' }),
        command('c', 'Charlie', { section: 'One' }),
      ],
      '',
    )
    const grouped = groupMatches(matches)
    expect(grouped.map((group) => group.section)).toEqual(['One', 'Two'])
    expect(grouped[0]?.matches.map((match) => match.command.id)).toEqual(['a', 'c'])
  })

  it('is empty for no matches', () => {
    expect(groupMatches([])).toEqual([])
  })
})
