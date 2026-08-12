import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LANGS, INSTR_LANGS, DATE_LOCALES } from './i18n-core.js'

const LOCALE_DIR = join(import.meta.dirname, '..', 'locales')
const INSTR_DIR = join(import.meta.dirname, '..', 'instr')
const SRC_DIR = join(import.meta.dirname, '..')

const localeFiles = readdirSync(LOCALE_DIR).filter(f => f.endsWith('.js'))

// A duplicate key in an object literal is not a syntax error — the last one silently wins.
// Two kinds, and only one is a bug:
//   · same key, same value  — dead weight (every upstream pack has two of these)
//   · same key, DIFFERENT value — a translation that can never be reached, because the loser
//     is overwritten at import time. This is the shape the Persian pack shipped with.
// So the hard assertion is on conflicts, and fa.js (regenerated from a de-duplicated map)
// is additionally held to zero duplicates of any kind.
function duplicateKeys(file) {
  const src = readFileSync(join(LOCALE_DIR, file), 'utf8')
  const seen = new Map()
  const all = [], conflicting = []
  // Keys are quoted at the start of a line in every pack; values may contain anything.
  const re = /^\s*(?:'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)")\s*:\s*(.*?),?\s*$/gm
  let m
  while ((m = re.exec(src)) !== null) {
    const key = m[1] ?? m[2]
    const value = (m[3] || '').replace(/,$/, '').trim()
    if (seen.has(key)) {
      all.push(key)
      if (seen.get(key) !== value) conflicting.push(key)
    } else seen.set(key, value)
  }
  return { all, conflicting, count: seen.size }
}

describe('locale packs', () => {
  for (const file of localeFiles) {
    it(`${file} has no key defined twice with different translations`, () => {
      const { conflicting, count } = duplicateKeys(file)
      expect(conflicting).toEqual([])
      expect(count).toBeGreaterThan(0)
    })
  }

  it('fa.js has no duplicate keys at all', () => {
    expect(duplicateKeys('fa.js').all).toEqual([])
  })
})

describe('language registry', () => {
  it('has a pack for every language offered in Settings except English', () => {
    const shipped = new Set(localeFiles.map(f => f.replace(/\.js$/, '')))
    for (const code of Object.keys(LANGS)) {
      if (code === 'en') continue
      expect(shipped.has(code), `missing locales/${code}.js`).toBe(true)
    }
  })

  it('offers no pack for a language Settings does not list', () => {
    for (const code of localeFiles.map(f => f.replace(/\.js$/, ''))) {
      expect(LANGS[code], `locales/${code}.js is not in LANGS`).toBeTruthy()
    }
  })

  it('has a date locale for every language', () => {
    for (const code of Object.keys(LANGS)) expect(DATE_LOCALES[code], code).toBeTruthy()
  })

  // setLang() imports instr/<lang>.js for anything listed here. Listing a language with no
  // pack made the dynamic import throw, and the catch reset the whole dictionary to {} — which
  // is exactly how Persian ended up displaying in English after being selected.
  it('lists an instruction language only when the pack exists', () => {
    const shipped = new Set(readdirSync(INSTR_DIR).filter(f => f.endsWith('.js')).map(f => f.replace(/\.js$/, '')))
    for (const code of INSTR_LANGS) {
      if (code === 'en') continue
      expect(shipped.has(code), `INSTR_LANGS lists ${code} but instr/${code}.js does not exist`).toBe(true)
    }
  })
})

// Every t('…') in the app, so a pack can be checked for coverage rather than eyeballed.
function sourceKeys() {
  const keys = new Set()
  const re = /\bt\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'locales' || entry.name === 'instr' || entry.name === 'node_modules') continue
      const p = join(dir, entry.name)
      if (entry.isDirectory()) { walk(p); continue }
      if (!/\.jsx?$/.test(entry.name) || entry.name.includes('.test.')) continue
      const src = readFileSync(p, 'utf8')
      let m
      while ((m = re.exec(src)) !== null) {
        keys.add(m[2].replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\`/g, '`').replace(/\\n/g, '\n'))
      }
    }
  }
  walk(SRC_DIR)
  return keys
}

describe('Persian pack', () => {
  it('covers every translatable string in the app', async () => {
    const fa = (await import('../locales/fa.js')).default
    const missing = [...sourceKeys()].filter(k => !(k in fa))
    expect(missing).toEqual([])
  })

  // Weekday and month names are translated through t(DAYN[d]) and t(MONTHS_LONG[m]). The scan
  // above only sees literal t('…') calls, so these went untranslated for months while every test
  // passed — the Persian UI printed "Saturday" and "August".
  it('translates the day and month names, which reach t() through a variable', async () => {
    const fa = (await import('../locales/fa.js')).default
    const { DAYN, MONTHS_LONG } = await import('./format.js')
    for (const k of [...DAYN, ...MONTHS_LONG]) {
      expect(fa[k], k).toBeTruthy()
      expect(fa[k], k).not.toBe(k)
    }
  })

  it('translates rather than echoing the English back', async () => {
    const fa = (await import('../locales/fa.js')).default
    const PASSTHROUGH = new Set(['kg', 'lb', 'RIR', 'RPE', '1RM', 'openGym', 'CSV', 'AI'])
    const echoed = Object.entries(fa)
      .filter(([k, v]) => k === v && !PASSTHROUGH.has(k) && /[a-zA-Z]{3}/.test(k))
      .map(([k]) => k)
    expect(echoed).toEqual([])
  })

  it('is actually in Persian script', async () => {
    const fa = (await import('../locales/fa.js')).default
    const values = Object.values(fa)
    const persian = values.filter(v => /[\u0600-\u06FF]/.test(v))
    // Allowing for a handful of unit/abbreviation passthroughs.
    expect(persian.length).toBeGreaterThan(values.length * 0.9)
  })
})
