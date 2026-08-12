import { beforeEach, describe, expect, it, vi } from 'vitest'
import { seedFirstRun } from './firstrun.js'
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
  unit: 'kg', lang: 'fa', routines: [], week: {}, dayPlan: {}, exWeights: {},
  workouts: [], active: null, customEx: [], bodyweight: [], coach: null,
})

describe('seedFirstRun', () => {
  let S
  beforeEach(() => { S = freshState() })

  // The preset plans (a no-equipment 3-day plan and a Push/Pull/Legs one) were removed:
  // a prescription nobody asked for has to be deleted before it can be replaced. These
  // three assertions are what stop it coming back.
  it('creates no routines', async () => {
    await seedFirstRun(S)
    expect(S.routines).toEqual([])
  })

  it('schedules nothing on the week', async () => {
    await seedFirstRun(S)
    expect(S.week).toEqual({})
  })

  it('leaves the coach profile unset, so the coach still asks its questions', async () => {
    await seedFirstRun(S)
    expect(S.coach).toBeFalsy()
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

  it('sets the starting language when asked, and loads the pack with it', async () => {
    await seedFirstRun(S, { lang: 'fa' })
    expect(S.lang).toBe('fa')
    expect(getLang()).toBe('fa')
  })

  it('leaves the language alone when not asked', async () => {
    // '' means "no build-time override" — the store default (fa) already applies, and
    // overwriting it here would undo a language the user had chosen.
    const T = freshState()
    T.lang = 'en'
    await seedFirstRun(T, { lang: '' })
    expect(T.lang).toBe('en')
  })
})

// The guard matters more than the seed: seeding over real data would bury someone's plan. This
// is the exact condition boot() uses.
describe('first-run guard', () => {
  const hasData = st => !!((st.workouts || []).length || (st.routines || []).length || (st.bodyweight || []).length)

  it('treats a truly empty state as a first run', () => {
    expect(hasData(freshState())).toBe(false)
  })

  it('does not treat a state with any of the three as a first run', () => {
    for (const key of ['workouts', 'routines', 'bodyweight']) {
      const S = freshState()
      S[key] = [{}]
      expect(hasData(S), key).toBe(true)
    }
  })

  // Without a seeded plan a first run leaves the state empty, so hasData stays false and
  // boot() will take the seed branch again on the next launch. That is now harmless (the
  // seed writes nothing), and this pins that it stays harmless.
  it('is idempotent — seeding twice changes nothing', async () => {
    const a = await seedFirstRun(freshState())
    const b = await seedFirstRun(await seedFirstRun(freshState()))
    expect(b).toEqual(a)
  })
})
