import { beforeEach, describe, expect, it, vi } from 'vitest'

// loadHomePlan is the wiring between the plan spec and the store: three routines pushed, three
// days of the week pointed at them. The bug it guards against is the one the AI-apply path had —
// the routines exist but the week still says Rest, so the Plan screen looks empty and the Home
// screen never offers today's workout.

const mocks = vi.hoisted(() => ({ S: null, toasts: [], navs: [] }))

const freshState = () => ({
  unit: 'kg', lang: 'fa', routines: [], week: {}, dayPlan: {}, exWeights: {},
  workouts: [], active: null, customEx: [], bodyweight: [],
})

vi.mock('../store/useStore.js', () => ({
  useStore: { getState: () => ({ S: mocks.S, update: mut => { mut(mocks.S) } }) },
}))
vi.mock('../store/useUI.js', () => ({
  useUI: { getState: () => ({ toast: m => mocks.toasts.push(m), openSheet: () => {} }) },
}))
vi.mock('./nav.js', () => ({ nav: to => mocks.navs.push(to) }))

let loadHomePlan, HOME_DAYS, EXIDX

beforeEach(async () => {
  mocks.S = freshState()
  mocks.toasts = []
  mocks.navs = []
  vi.resetModules()
  ;({ loadHomePlan } = await import('../sheets.jsx'))
  ;({ HOME_DAYS } = await import('./homeplan.js'))
  ;({ EXIDX } = await import('./exercises.js'))
})

describe('loadHomePlan', () => {
  it('adds the three routines to the plan', () => {
    loadHomePlan()
    expect(mocks.S.routines).toHaveLength(3)
    for (const r of mocks.S.routines) expect(r.ex.length).toBeGreaterThan(0)
  })

  it('schedules them on the week, pointing at ids that exist', () => {
    loadHomePlan()
    const scheduled = Object.values(mocks.S.week)
    expect(scheduled).toHaveLength(3)
    const ids = new Set(mocks.S.routines.map(r => r.id))
    for (const id of scheduled) expect(ids.has(id)).toBe(true)
    for (const d of HOME_DAYS) expect(mocks.S.week[d]).toBeTruthy()
  })

  it('lands the user on the Plan screen so the result is visible', () => {
    loadHomePlan()
    expect(mocks.navs).toEqual(['/plan'])
    expect(mocks.toasts).toHaveLength(1)
  })

  it('leaves every scheduled day with a routine the Plan screen can render', () => {
    loadHomePlan()
    for (const d of HOME_DAYS) {
      const r = mocks.S.routines.find(x => x.id === mocks.S.week[d])
      expect(r, `day ${d} points at a missing routine`).toBeTruthy()
      expect(r.ex.length).toBeGreaterThan(0)
      for (const e of r.ex) expect(EXIDX[e.id]).toBeTruthy()
    }
  })

  it('does not disturb a plan that is already there', () => {
    mocks.S.routines.push({ id: 'mine', name: 'My routine', emoji: 'barbell', ex: [] })
    mocks.S.week[2] = 'mine'
    loadHomePlan()
    expect(mocks.S.routines).toHaveLength(4)
    expect(mocks.S.week[2]).toBe('mine')
  })
})
