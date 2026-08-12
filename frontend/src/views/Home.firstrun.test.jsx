import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { parseHTML } from 'linkedom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The first screen after a fresh install. A fresh install no longer gets a preset plan, so
// what this pins is that the empty state is a usable starting point rather than a dead end:
// it offers the two routes to a plan (build it, or have the coach write it) and it renders in
// Persian, which is the default language.
//
// Home is mounted for real — effectiveRoutine, the week strip and the glyph lookup are the
// actual implementations.
//
// Everything is imported statically and there is no resetModules: i18n keeps its dictionary in
// module scope, and a registry reset hands the mock factory and the module under test two
// different copies of it, so setLang would appear to do nothing.

const mocks = vi.hoisted(() => ({ S: null, navs: [], sheets: [], ai: { base: '', key: '', model: '' } }))

vi.mock('../store/useStore.js', () => ({
  useStore: selector => selector({ S: mocks.S, user: null, update: mut => { mut(mocks.S) } }),
}))
vi.mock('react-router-dom', () => ({ useNavigate: () => to => mocks.navs.push(to) }))
vi.mock('../sheets.jsx', () => ({
  bwSheet: () => mocks.sheets.push('bw'),
  goalSheet: () => mocks.sheets.push('goal'),
  dayOverrideSheet: d => mocks.sheets.push('day:' + d),
  calendarSheet: () => mocks.sheets.push('cal'),
  startFlow: id => mocks.sheets.push('start:' + id),
  bwDeltaColor: () => 'var(--green)',
  aiSetupSheet: () => mocks.sheets.push('aiSetup'),
}))
// The coach shortcut on Home reads this; the real module touches localStorage at import time.
vi.mock('../lib/aiconfig.js', () => ({
  useAi: () => mocks.ai,
  aiReady: (c = mocks.ai) => !!(c.base && c.key && c.model),
}))
// glyphs.js imports ICON_NAMES from this module, so the mock has to keep the real exports.
vi.mock('../components/Icon.jsx', async importOriginal => ({
  ...(await importOriginal()),
  default: ({ name }) => React.createElement('span', { 'data-icon': name }),
}))
vi.mock('../components/LineChart.jsx', () => ({ default: () => React.createElement('div', { 'data-chart': '1' }) }))
// The real setLang lazy-loads packs with import.meta.glob, which needs Vite's transform.
vi.mock('../lib/i18n.js', async () => {
  const core = await import('../lib/i18n-core.js')
  return {
    ...core,
    setLang: async l => {
      const dict = l === 'en' ? {} : (await import(`../locales/${l}.js`)).default
      core._setLangState(l, dict, null)
    },
    useLang: () => 0,
  }
})

import Home from '../views/Home.jsx'
import { seedFirstRun } from '../lib/firstrun.js'
import { setLang } from '../lib/i18n.js'
import { getLang, _setLangState } from '../lib/i18n-core.js'

const freshState = () => ({
  unit: 'kg', restSec: 90, sound: true, lang: 'en', theme: 'dark', accent: 'lime',
  body: 'male', targetW: null, bodyweight: [], routines: [], week: {}, dayPlan: {},
  exWeights: {}, workouts: [], active: null, customEx: [], reminder: { on: false }, effort: null,
})

let dom, root, container

beforeEach(() => {
  mocks.S = freshState()
  mocks.navs = []
  mocks.sheets = []
  mocks.ai = { base: '', key: '', model: '' }

  const parsed = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>')
  dom = parsed.window
  globalThis.window = dom
  globalThis.document = dom.document
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.navigator })
  for (const key of ['HTMLElement', 'Node', 'Element', 'Event', 'KeyboardEvent']) globalThis[key] = dom[key]
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  dom.scrollTo = () => {}

  container = document.getElementById('root')
  root = createRoot(container)
})

afterEach(async () => {
  if (root) await act(async () => { root.unmount() })
  root = null; container = null; dom = null
  _setLangState('en', {}, null)   // language is module-global; don't leak it into the next test
  vi.restoreAllMocks()
})

const mount = async () => { await act(async () => { root.render(React.createElement(Home)) }) }
const text = () => container.textContent
const todayISO = () => {
  const d = new Date()
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-')
}

// The shortcut is the only way to reach the coach from the screen the app opens on, so both of
// its states are pinned: prompt to set up when there is no key, straight through when there is.
describe('the AI coach shortcut on Home', () => {
  const shortcut = () => container.querySelector('.ai-shortcut')

  it('opens the setup sheet while no key is configured', async () => {
    await mount()
    expect(text()).toContain('Set up the AI coach')
    await act(async () => { shortcut().dispatchEvent(new dom.Event('click', { bubbles: true })) })
    expect(mocks.sheets).toContain('aiSetup')
    expect(mocks.navs).not.toContain('/coach')
  })

  it('goes to the coach once a key is configured', async () => {
    mocks.ai = { base: 'https://api.anthropic.com', key: 'sk-ant', model: 'claude-3-5-haiku-latest' }
    await mount()
    await act(async () => { shortcut().dispatchEvent(new dom.Event('click', { bubbles: true })) })
    expect(mocks.navs).toContain('/coach')
    expect(mocks.sheets).not.toContain('aiSetup')
  })
})

describe('Home on a fresh install', () => {
  it('shows the welcome state, since there is no plan yet', async () => {
    await mount()
    expect(text()).toContain('Welcome!')
  })

  it('offers no preset plan to load', async () => {
    // The two canned plans are gone. If either button comes back, the empty state is
    // handing out a programme again.
    await mount()
    expect(text()).not.toMatch(/Push \/ Pull \/ Legs/)
    expect(text()).not.toMatch(/no equipment/i)
    expect(mocks.sheets).not.toContain('starter')
    expect(mocks.sheets).not.toContain('home')
  })

  it('offers both routes to a plan: build it, or let the coach write it', async () => {
    await mount()
    expect(text()).toContain('Build my own plan')
    expect(text()).toContain('Let the AI coach write one')
  })

  it('the build-my-own button goes to the plan screen', async () => {
    await mount()
    const btn = [...container.querySelectorAll('button')]
      .find(b => b.textContent.includes('Build my own plan'))
    await act(async () => { btn.dispatchEvent(new dom.Event('click', { bubbles: true })) })
    expect(mocks.navs).toContain('/plan')
  })

  it('seeding leaves the week empty', async () => {
    await seedFirstRun(mocks.S, { lang: '', bodyweight: 0 })
    await mount()
    expect(mocks.S.routines).toEqual([])
    expect(container.querySelectorAll('.dot.plan, .dot.done')).toHaveLength(0)
    expect(text()).toContain('Welcome!')
  })

  it('shows the seeded starting weight', async () => {
    await seedFirstRun(mocks.S, { lang: '', bodyweight: 80 })
    await mount()
    expect(text()).toContain('80')
  })

  it('renders the welcome state in Persian, the default language', async () => {
    await setLang('fa')
    expect(getLang()).toBe('fa')
    await mount()
    // The screen the app opens on must be translated, not a half-English fallback.
    expect(text()).toMatch(/[\u0600-\u06FF]/)
    expect(text()).not.toContain('Welcome!')
    expect(text()).not.toContain('Build my own plan')
  })
})
