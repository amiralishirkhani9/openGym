import { beforeEach, describe, expect, it, vi } from 'vitest'

// boot() on the mobile build is the only path that seeds a first launch, and the branch it lives
// in is easy to get wrong in three ways, all of which this pins down:
//   · fresh install (no mirror file, no localStorage) → seed the plan
//   · returning install (mirror file exists)          → restore it, seed nothing
//   · reset install (mirror exists but is empty)      → still seed nothing, or a reset would be
//     silently undone on the next launch
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

let useStore, HOME_DAYS

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
  ;({ HOME_DAYS } = await import('../lib/homeplan.js'))
})

describe('first launch on mobile', () => {
  it('seeds a usable plan when there is nothing to restore', async () => {
    await useStore.getState().boot()
    const S = useStore.getState().S
    expect(S.routines).toHaveLength(3)
    for (const d of HOME_DAYS) expect(S.week[d]).toBeTruthy()
    expect(useStore.getState().ready).toBe(true)
  })

  it('waits for the seed before reporting ready, so Home never renders an empty week', async () => {
    // seedFirstRun is async (it loads a locale pack first). A missing await here would set
    // ready:true with routines still empty, and the first paint would be the empty state.
    await useStore.getState().boot()
    expect(useStore.getState().ready).toBe(true)
    expect(useStore.getState().S.routines).toHaveLength(3)
  })

  it('opens straight into the app, with no sign-in step', async () => {
    // Single-user build: boot() is the whole startup sequence. Nothing may gate
    // `ready` behind an account, because there is no way to obtain one.
    await useStore.getState().boot()
    expect(useStore.getState().ready).toBe(true)
    expect(useStore.getState().user).toBeUndefined()
  })

  it('restores the mirror instead of seeding when one exists', async () => {
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

  it('does not re-seed an install that was deliberately reset', async () => {
    // "Reset everything" leaves a real but empty mirror. Seeding here would resurrect a plan the
    // user just deleted.
    mocks.saved = {
      _ts: Date.now(), routines: [], week: {}, workouts: [], bodyweight: [],
      customEx: [], exWeights: {}, dayPlan: {},
    }
    await useStore.getState().boot()
    expect(useStore.getState().S.routines).toEqual([])
  })

  it('seeds once, not on every launch', async () => {
    await useStore.getState().boot()
    const first = useStore.getState().S.routines.map(r => r.id)
    // Second launch: the mirror now holds what the first launch wrote.
    mocks.saved = JSON.parse(JSON.stringify(useStore.getState().S))
    vi.resetModules()
    ;({ useStore } = await import('../store/useStore.js'))
    await useStore.getState().boot()
    const second = useStore.getState().S.routines.map(r => r.id)
    expect(second).toEqual(first)
    expect(second).toHaveLength(3)
  })
})
