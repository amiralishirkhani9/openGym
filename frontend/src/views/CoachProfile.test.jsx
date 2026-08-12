import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseHTML } from 'linkedom'
import React, { act } from 'react'
// Imported at module load, on purpose: react-dom/client reads window.location at init, and
// linkedom's window has no location. Loading it before any window exists takes the guarded path
// instead — the same reason AiCoach.test.jsx imports it up here.
import { createRoot } from 'react-dom/client'

// The profile form is the only place the app asks what the user can actually do. If a control does
// not write to state, the coach silently keeps planning for the defaults — a bug with no visible
// symptom until a plan comes back full of barbells.

const mocks = vi.hoisted(() => ({ S: null, sheet: null, toasts: [], updates: 0 }))

vi.mock('../store/useStore.js', () => {
  const st = {
    get S() { return mocks.S },
    update: fn => { mocks.updates++; fn(mocks.S) },
  }
  const useStore = sel => (sel ? sel(st) : st)
  useStore.getState = () => st
  return { useStore, DEF: {} }
})
vi.mock('../store/useUI.js', () => {
  const st = {
    openSheet: render => { mocks.sheet = render; return 1 },
    closeSheet: () => {},
    toast: m => { mocks.toasts.push(m) },
  }
  const useUI = sel => (sel ? sel(st) : st)
  useUI.getState = () => st
  return { useUI }
})
// Not under test here, and both reach for browser APIs this DOM does not have.
vi.mock('../lib/sound.js', () => ({ beep: () => {}, vibrate: () => {} }))
vi.mock('../components/Media.jsx', () => ({
  default: () => null,
  Thumb: () => null,
}))
vi.mock('../components/BodyMap.jsx', () => ({ default: () => null }))

let container, root, dom

beforeEach(async () => {
  const parsed = parseHTML('<!doctype html><html><body><div id="r"></div></body></html>')
  dom = parsed.window
  globalThis.window = dom
  globalThis.document = dom.document
  // navigator is a getter on globalThis in node, so plain assignment throws.
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.navigator })
  for (const k of ['HTMLElement', 'Node', 'Element', 'Event', 'KeyboardEvent']) globalThis[k] = dom[k]
  globalThis.IS_REACT_ACT_ENVIRONMENT = true

  mocks.S = {
    unit: 'kg', lang: 'fa', routines: [], week: {}, workouts: [], bodyweight: [],
    customEx: [], coach: null,
  }
  mocks.sheet = null
  mocks.toasts = []
  mocks.updates = 0

  globalThis.localStorage = {
    _d: {},
    getItem(k) { return this._d[k] ?? null },
    setItem(k, v) { this._d[k] = String(v) },
    removeItem(k) { delete this._d[k] },
  }
  container = dom.document.getElementById('r')
  root = createRoot(container)
})

afterEach(async () => { if (root) await act(async () => root.unmount()) })

const open = async onBuild => {
  const { coachProfileSheet } = await import('../sheets.jsx')
  coachProfileSheet(onBuild)
  expect(mocks.sheet, 'the sheet was opened').toBeTruthy()
  await act(async () => { root.render(mocks.sheet(() => {})) })
}

const propsOf = el => el[Object.keys(el).find(k => k.startsWith('__reactProps'))]
const click = async el => { await act(async () => { propsOf(el).onClick({ preventDefault() {}, stopPropagation() {} }) }) }
const chips = () => [...container.querySelectorAll('.chip')]
const chip = label => chips().find(b => b.textContent.trim() === label)
const byText = txt => [...container.querySelectorAll('button')].find(b => b.textContent.trim() === txt)
const selects = () => [...container.querySelectorAll('select')]
const change = async (el, value) => { await act(async () => { propsOf(el).onChange({ target: { value } }) }) }

describe('the training profile form', () => {
  it('opens showing the defaults rather than an empty form', async () => {
    // A form that starts blank cannot be saved by pressing one button, which is the whole point of
    // the shortcut from the coach screen.
    await open()
    expect(selects()).toHaveLength(2)                       // experience, place
    expect(chips().some(c => c.classList.contains('on')), 'something is preselected').toBe(true)
    expect(container.querySelector('textarea')).toBeTruthy()
  })

  it('saves what was on screen and marks the profile answered', async () => {
    await open()
    await click(byText('Save only'))
    expect(mocks.updates).toBe(1)
    expect(mocks.S.coach._set).toBe(true)
    expect(mocks.S.coach.place).toBeTruthy()
    expect(mocks.S.coach.days.length).toBeGreaterThan(0)
    expect(mocks.toasts.at(-1)).toBe('Profile saved')
  })

  it('writes the equipment answer, which is what filters the exercises', async () => {
    await open()
    const place = selects()[1]
    await change(place, 'gym_full')
    await click(byText('Save only'))
    expect(mocks.S.coach.place).toBe('gym_full')
  })

  it('writes the experience answer', async () => {
    await open()
    await change(selects()[0], 'advanced')
    await click(byText('Save only'))
    expect(mocks.S.coach.level).toBe('advanced')
  })

  it('toggles a training day on and off', async () => {
    await open()
    const fri = chip('Friday')
    expect(fri).toBeTruthy()
    const was = fri.classList.contains('on')
    await click(fri)
    await click(byText('Save only'))
    expect(mocks.S.coach.days.includes(5)).toBe(!was)
  })

  it('refuses to leave zero training days', async () => {
    // Zero days means the coach has nowhere to put the plan, and the week comes back empty.
    await open()
    for (const d of ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']) {
      const c = chip(d)
      if (c && c.classList.contains('on')) await click(c)
    }
    await click(byText('Save only'))
    expect(mocks.S.coach.days.length).toBeGreaterThanOrEqual(1)
  })

  it('refuses to leave zero goals', async () => {
    await open()
    for (const g of ['Lose fat', 'Get stronger', 'Build muscle', 'Conditioning', 'General fitness']) {
      const c = chip(g)
      if (c && c.classList.contains('on')) await click(c)
    }
    await click(byText('Save only'))
    expect(mocks.S.coach.goals.length).toBeGreaterThanOrEqual(1)
  })

  it('records an injury area, and lets it be cleared again', async () => {
    await open()
    const knee = chip('Knees')
    await click(knee)
    await click(byText('Save only'))
    expect(mocks.S.coach.limits).toContain('knee')

    await open()
    await click(chip('Knees'))
    await click(byText('Save only'))
    expect(mocks.S.coach.limits).not.toContain('knee')
  })

  it('keeps free-text notes, which is where the specifics live', async () => {
    await open()
    const ta = container.querySelector('textarea')
    await act(async () => { propsOf(ta).onChange({ target: { value: 'I hate burpees' } }) })
    await click(byText('Save only'))
    expect(mocks.S.coach.notes).toBe('I hate burpees')
  })

  it('shows how many exercises a session of that length holds', async () => {
    // The number is the honest consequence of the slider, so a 20-minute answer does not come
    // back as a 7-exercise workout.
    await open()
    expect(container.textContent).toMatch(/\d+ exercises/)
  })

  it('runs the build callback after saving, not before', async () => {
    let sawProfile
    await open(() => { sawProfile = mocks.S.coach })
    await click(byText('Build my plan'))
    expect(sawProfile, 'the callback ran').toBeTruthy()
    expect(sawProfile._set).toBe(true)
  })

  it('does not build when only saving', async () => {
    let built = false
    await open(() => { built = true })
    await click(byText('Save only'))
    expect(built).toBe(false)
    expect(mocks.S.coach._set).toBe(true)
  })

  it('reopens with the saved answers rather than the defaults', async () => {
    mocks.S.coach = { _set: true, level: 'advanced', place: 'gym_full', days: [2], goals: ['muscle'], sessionMin: 90, limits: ['shoulder'], notes: 'x' }
    await open()
    expect(propsOf(selects()[0]).value).toBe('advanced')
    expect(propsOf(selects()[1]).value).toBe('gym_full')
    expect(propsOf(container.querySelector('textarea')).value).toBe('x')
    expect(chip('Tuesday').classList.contains('on')).toBe(true)
    expect(chip('Shoulders').classList.contains('on')).toBe(true)
  })
})
