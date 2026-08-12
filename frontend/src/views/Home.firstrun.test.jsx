import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { parseHTML } from 'linkedom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The first screen after a fresh install. The failure this guards against is the one the whole
// seed exists to prevent: Home rendering its "Welcome! load a plan" empty state, or a week strip
// with no planned days, because state was seeded in a shape Home does not read.
//
// Home is mounted for real against a seeded state — effectiveRoutine, the week strip and the
// glyph lookup are the actual implementations.
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
  loadStarterPlan: () => mocks.sheets.push('starter'),
  loadHomePlan: () => mocks.sheets.push('home'),
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
import { HOME_DAYS } from '../lib/homeplan.js'
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

describe('Home after a first-run seed', () => {
  it('shows the empty state when nothing is seeded', async () => {
    await mount()
    expect(text()).toContain('Welcome!')
  })

  it('does not show the empty state once the plan is seeded', async () => {
    await seedFirstRun(mocks.S, { lang: '', bodyweight: 0 })
    await mount()
    expect(text()).not.toContain('Welcome!')
  })

  it('marks the seeded days as planned on the week strip', async () => {
    await seedFirstRun(mocks.S, { lang: '', bodyweight: 0 })
    await mount()
    const planned = container.querySelectorAll('.dot.plan, .dot.done')
    expect(planned.length).toBe(HOME_DAYS.length)
  })

  it('offers a real session on a planned day rather than "Rest day"', async () => {
    await seedFirstRun(mocks.S, { lang: '', bodyweight: 0 })
    // Pin today onto one of the plan's days via the per-day override Home reads first.
    mocks.S.dayPlan[todayISO()] = mocks.S.routines[0].id
    await mount()
    expect(text()).toContain(mocks.S.routines[0].name)
    expect(text()).toContain('Start')
  })

  it('shows the seeded starting weight', async () => {
    await seedFirstRun(mocks.S, { lang: '', bodyweight: 80 })
    await mount()
    expect(text()).toContain('80')
  })

  it('renders in Persian when seeded in Persian', async () => {
    await seedFirstRun(mocks.S, { lang: 'fa', bodyweight: 80 })
    expect(getLang()).toBe('fa')
    // Routine names are stored strings, translated once at creation — so this is the assertion
    // that the seed ran *after* the locale pack loaded. See the comment on seedFirstRun.
    for (const r of mocks.S.routines) expect(r.name, r.name).toMatch(/[\u0600-\u06FF]/)
    mocks.S.dayPlan[todayISO()] = mocks.S.routines[0].id
    await mount()
    expect(text()).toContain(mocks.S.routines[0].name)
    expect(text()).not.toContain('Rest day')
    expect(text()).not.toContain('Welcome!')
  })
})
