import { beforeEach, describe, expect, it, vi } from 'vitest'
import { seedFirstRun } from './firstrun.js'
import { HOME_DAYS } from './homeplan.js'
import { EXIDX } from './exercises.js'
import { getLang } from './i18n-core.js'

// i18n.js loads packs through import.meta.glob, which only exists under Vite's transform. The
// real pack is imported here so the language assertions run against actual translations.
vi.mock('./i18n.js', async () => {
  const core = await import('./i18n-core.js')
  return {
    ...core,
    setLang: async l => {
      const dict = l === 'en' ? {} : (await import(`../locales/${l}.js`)).default
      core._setLangState(l, dict, null)
    },
  }
})

const freshState = () => ({
  unit: 'kg', lang: 'en', routines: [], week: {}, dayPlan: {}, exWeights: {},
  workouts: [], active: null, customEx: [], bodyweight: [],
})

describe('seedFirstRun', () => {
  let S
  beforeEach(() => { S = freshState() })

  it('leaves a first launch with a plan it can actually start', async () => {
    await seedFirstRun(S)
    expect(S.routines).toHaveLength(3)
    for (const d of HOME_DAYS) {
      const r = S.routines.find(x => x.id === S.week[d])
      expect(r, `day ${d} is unscheduled`).toBeTruthy()
      expect(r.ex.length).toBeGreaterThan(0)
      for (const e of r.ex) expect(EXIDX[e.id]).toBeTruthy()
    }
  })

  it('records the starting weight when one is given', async () => {
    await seedFirstRun(S, { bodyweight: 80 })
    expect(S.bodyweight).toHaveLength(1)
    expect(S.bodyweight[0].w).toBe(80)
    expect(S.bodyweight[0].d).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('records no weigh-in when none is given', async () => {
    await seedFirstRun(S, { bodyweight: 0 })
    expect(S.bodyweight).toEqual([])
  })

  it('never overwrites a weigh-in that is already there', async () => {
    S.bodyweight.push({ d: '2026-01-01', w: 91, t: 1 })
    await seedFirstRun(S, { bodyweight: 80 })
    expect(S.bodyweight).toHaveLength(1)
    expect(S.bodyweight[0].w).toBe(91)
  })

  it('sets the starting language only when asked', async () => {
    await seedFirstRun(S, { lang: 'fa' })
    expect(S.lang).toBe('fa')
    const T = freshState()
    await seedFirstRun(T, { lang: '' })
    expect(T.lang).toBe('en')
  })

  it('names the seeded routines in the seeded language, not English', async () => {
    // Routine names are stored strings, translated once at creation. If the pack is not loaded
    // before homeRoutines() runs, the plan is stuck with English names forever.
    await seedFirstRun(S, { lang: 'fa' })
    expect(getLang()).toBe('fa')
    for (const r of S.routines) {
      expect(r.name, r.name).toMatch(/[\u0600-\u06FF]/)
      expect(r.name).not.toMatch(/Home Day/)
    }
  })

  it('produces different routine ids each time, so seeding twice cannot collide', async () => {
    const a = (await seedFirstRun(freshState())).routines.map(r => r.id)
    const b = (await seedFirstRun(freshState())).routines.map(r => r.id)
    expect(a).not.toEqual(b)
  })
})

// The guard matters more than the seed: seeding over real data would bury someone's plan under a
// duplicate set of routines. This is the exact condition boot() uses.
describe('first-run guard', () => {
  const hasData = st => !!((st.workouts || []).length || (st.routines || []).length || (st.bodyweight || []).length)

  it('treats a truly empty state as a first run', async () => {
    expect(hasData(freshState())).toBe(false)
  })

  it('does not treat a state with any of the three as a first run', async () => {
    for (const key of ['workouts', 'routines', 'bodyweight']) {
      const S = freshState()
      S[key] = [{}]
      expect(hasData(S), key).toBe(true)
    }
  })

  it('reports data once seeded, so a second boot cannot seed again', async () => {
    const S = await seedFirstRun(freshState())
    expect(hasData(S)).toBe(true)
  })

  // The seeded plan and the coach profile have to agree, or the coach's first suggestion
  // contradicts what is already on the screen.
  it('seeds a coach profile that matches the plan it just wrote', async () => {
    const S = freshState()
    await seedFirstRun(S, { lang: '', bodyweight: 0 })
    expect(S.coach).toBeTruthy()
    expect(S.coach._set).toBe(true)
    expect(S.coach.place).toBe('home_none')
    expect(S.coach.level).toBe('beginner')
    expect(S.coach.days.sort()).toEqual([...HOME_DAYS].sort())
  })
})
