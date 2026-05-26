export type ThemeId =
  | 'relo-os'
  | 'relo-official'
  | 'relo-classic'
  | 'relo-slate'
  | 'relo-mono'

export const THEMES: Array<{
  id: ThemeId
  label: string
  description: string
  icon: string
}> = [
  {
    id: 'relo-os',
    label: 'Relo OS',
    description: 'Electric blue cinematic agent OS theme',
    icon: '◈',
  },
  {
    id: 'relo-official',
    label: 'Relo Official',
    description: 'Navy and indigo flagship theme',
    icon: '⚕',
  },
  {
    id: 'relo-classic',
    label: 'Relo Classic',
    description: 'Bronze accents on dark charcoal',
    icon: '🔶',
  },
  {
    id: 'relo-slate',
    label: 'Relo Slate',
    description: 'Cool blue developer theme',
    icon: '🔷',
  },
  {
    id: 'relo-mono',
    label: 'Relo Mono',
    description: 'Clean monochrome grayscale',
    icon: '◐',
  },
]

const STORAGE_KEY = 'relo-theme'
const DEFAULT_THEME: ThemeId = 'relo-os'
const THEME_SET = new Set<ThemeId>(THEMES.map((theme) => theme.id))

/** Migrate old hermes-* theme values to relo-* */
function migrateTheme(value: string | null): string | null {
  if (!value) return value
  const migration: Record<string, string> = {
    'hermes-os': 'relo-os',
    'hermes-official': 'relo-official',
    'hermes-classic': 'relo-classic',
    'hermes-slate': 'relo-slate',
    'hermes-mono': 'relo-mono',
  }
  if (value in migration) {
    const migrated = migration[value]
    try { localStorage.setItem(STORAGE_KEY, migrated) } catch {}
    return migrated
  }
  return value
}

export function isValidTheme(value: string | null | undefined): value is ThemeId {
  return typeof value === 'string' && THEME_SET.has(value as ThemeId)
}

export function getTheme(): ThemeId {
  if (typeof window === 'undefined') return DEFAULT_THEME
  let stored = localStorage.getItem(STORAGE_KEY)
  if (!stored) {
    stored = localStorage.getItem('hermes-theme')
    if (stored) {
      stored = migrateTheme(stored)
      try { localStorage.setItem(STORAGE_KEY, stored) } catch {}
    }
  }
  return isValidTheme(stored) ? stored : DEFAULT_THEME
}

export function setTheme(theme: ThemeId): void {
  const root = document.documentElement
  root.setAttribute('data-theme', theme)
  root.classList.remove('light', 'system')
  root.classList.add('dark')
  root.style.setProperty('color-scheme', 'dark')
  localStorage.setItem(STORAGE_KEY, theme)
}
