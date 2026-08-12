import { beforeEach, describe, expect, it, vi } from 'vitest'

// boot() is the whole startup sequence on the mobile build. Three branches, all easy to get
// wrong:
//   · fresh install (no mirror file, no localStorage) → start empty, ready to use
//   · returning install (mirror file exists)          → restore it
//   · reset install (mirror exists but is empty)      → leave it empty
//
// mobile.js is mocked because nativeLoad/nativeSave are Capacitor calls. There is no api.js mock
// any more: the single-user build has no backend, so there is nothing left to stub out.

const mocks = vi.hoisted(() => ({ saved: null, wrote: [], reminders: 0 }))

vi.mock('../lib/mobile.js', () => ({
  MOBILE: true,
  nativeLoad: async () => mocks.saved,
  nativeSave: S => { mocks.wrote.push(S) },
  syncReminder: () => { mocks.reminders++ },
  shareExport: async () => {},
}))
vi.mock('../lib/demo.js', () => ({ DEMO: false, DEMO_SEEDED: 'demo_seeded', DEMO_USER: null }))
// firstrun.js loads the locale pack through i18n.js, which needs Vite's import.meta.glob.
vi.mock('../lib/i18n.js', async () => {
  const core = await import('../lib/i18n-core.js')
  return {
    ...core,
    setLang: async l => {
      const dict = l === 'en' ? {} : (await import(`../locales/${l}.js`)).default
      core._setLangState(l, dict, null)
    },
  }
})

let useStore

// The store reads localStorage and adds a visibilitychange listener at module scope; the test
// runner has neither. Same minimal shims the AiCoach test uses.
const stubEnv = () => {
  const store = {}
  globalThis.localStorage = {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v) },
    removeItem: k => { delete store[k] },
    clear: () => { for (const k of Object.keys(store)) delete store[k] },
  }
  globalThis.document = { addEventListener() {}, visibilityState: 'visible' }
}

beforeEach(async () => {
  mocks.saved = null
  mocks.wrote = []
  mocks.reminders = 0
  stubEnv()
  vi.resetModules()
  ;({ useStore } = await import('../store/useStore.js'))
})

describe('first launch on mobile', () => {
  it('opens on an empty plan rather than a preset one', async () => {
    await useStore.getState().boot()
    const S = useStore.getState().S
    expect(S.routines).toEqual([])
    expect(S.week).toEqual({})
    expect(useStore.getState().ready).toBe(true)
  })

  it('starts in Persian', async () => {
    await useStore.getState().boot()
    expect(useStore.getState().S.lang).toBe('fa')
  })

  it('opens straight into the app, with no sign-in step', async () => {
    // Single-user build: nothing may gate `ready` behind an account, because there is no
    // way to obtain one.
    await useStore.getState().boot()
    expect(useStore.getState().ready).toBe(true)
    expect(useStore.getState().user).toBeUndefined()
  })

  it('restores the mirror when one exists', async () => {
    mocks.saved = {
      _ts: Date.now(),
      routines: [{ id: 'mine', name: 'My routine', emoji: 'barbell', ex: [] }],
      week: { 2: 'mine' }, workouts: [], bodyweight: [], customEx: [], exWeights: {}, dayPlan: {},
    }
    await useStore.getState().boot()
    const S = useStore.getState().S
    expect(S.routines).toHaveLength(1)
    expect(S.routines[0].id).toBe('mine')
    expect(S.week[2]).toBe('mine')
  })

  it('keeps a deliberately reset install empty', async () => {
    mocks.saved = {
      _ts: Date.now(), routines: [], week: {}, workouts: [], bodyweight: [],
      customEx: [], exWeights: {}, dayPlan: {},
    }
    await useStore.getState().boot()
    expect(useStore.getState().S.routines).toEqual([])
  })

  it('preserves a language the user chose, across launches', async () => {
    // The store default is fa, so switching to en and relaunching is the case that would
    // break if boot() re-applied the default over restored state.
    mocks.saved = {
      _ts: Date.now(), lang: 'en', routines: [], week: {}, workouts: [],
      bodyweight: [{ d: '2026-01-01', w: 80, t: 1 }], customEx: [], exWeights: {}, dayPlan: {},
    }
    await useStore.getState().boot()
    expect(useStore.getState().S.lang).toBe('en')
  })
})
