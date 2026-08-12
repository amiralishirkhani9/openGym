import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { parseHTML } from 'linkedom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The two failures this file exists for, both of which shipped:
//   1. The coach answered with a plan, the Apply button ran, and nothing appeared in Plan —
//      the action was parsed but never written to the store in a shape Plan reads.
//   2. On mobile the request itself died before any of that, because a Response-shaped object
//      from the CapacitorHttp fetch patch was parsed twice ("Unexpected non-whitespace
//      character after JSON at position N").
// So this mounts the real screen against a fake provider and asserts on the store.

const mocks = vi.hoisted(() => ({
  S: null,
  toasts: [],
  navs: [],
  sheets: 0,
  profileSheets: [],
  cfg: { base: 'https://api.test.dev', key: 'sk-test', model: 'gpt-test', autoTranslate: false },
  reply: '',
  requests: [],
  fail: null,
}))

const freshState = () => ({
  unit: 'kg', restSec: 90, sound: true, lang: 'fa', theme: 'dark', accent: 'lime',
  body: 'male', targetW: null, bodyweight: [], routines: [], week: {}, dayPlan: {},
  exWeights: {}, workouts: [], active: null, customEx: [], reminder: { on: false }, effort: null,
  coach: null,
})

vi.mock('../store/useStore.js', () => ({
  useStore: selector => selector({
    S: mocks.S,
    // The real store clones, mutates and persists; the contract the view depends on is that
    // the producer's mutations end up in S.
    update: mut => { mut(mocks.S) },
  }),
}))
vi.mock('../store/useUI.js', () => ({
  useUI: selector => selector({ toast: m => mocks.toasts.push(m) }),
}))
vi.mock('react-router-dom', () => ({ useNavigate: () => to => mocks.navs.push(to) }))
vi.mock('../sheets.jsx', () => ({
  aiSetupSheet: () => { mocks.sheets++ },
  // The real sheet is a form; what matters here is that the screen opens it, and that the
  // callback it passes is what fires the build request.
  coachProfileSheet: cb => { mocks.profileSheets.push(cb) },
}))
vi.mock('../lib/aiconfig.js', () => ({
  useAi: () => mocks.cfg,
  aiReady: (c = mocks.cfg) => !!(c.base && c.key && c.model),
  setAi: () => {},
}))
vi.mock('../components/Icon.jsx', () => ({ default: ({ name }) => React.createElement('span', { 'data-icon': name }) }))

// Only the transport is faked. buildSystemPrompt, parseActions and applyAction are the real
// implementations, which is the point — those are what turn a reply into routines.
vi.mock('../lib/ai.js', async importOriginal => {
  const real = await importOriginal()
  return {
    ...real,
    // chatComplete is the seam, not apiJSON: the real chatComplete calls the module's own
    // apiJSON binding, so faking apiJSON here would record nothing.
    chatComplete: async ({ model, messages, temperature, maxTokens, signal }) => {
      mocks.requests.push({ body: { model, messages, temperature, max_tokens: maxTokens }, signal })
      if (mocks.fail) throw new Error(mocks.fail)
      return mocks.reply
    },
  }
})

let AiCoach
let dom, root, container

beforeEach(async () => {
  mocks.S = freshState()
  mocks.toasts = []
  mocks.navs = []
  mocks.sheets = 0
  mocks.profileSheets = []
  mocks.requests = []
  mocks.fail = null
  mocks.reply = ''
  mocks.cfg = { base: 'https://api.test.dev', key: 'sk-test', model: 'gpt-test', autoTranslate: false }

  const parsed = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>')
  dom = parsed.window
  globalThis.window = dom
  globalThis.document = dom.document
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.navigator })
  for (const key of ['HTMLElement', 'Node', 'Element', 'Event', 'KeyboardEvent']) globalThis[key] = dom[key]
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  globalThis.localStorage = {
    _d: {},
    getItem(k) { return this._d[k] ?? null },
    setItem(k, v) { this._d[k] = String(v) },
    removeItem(k) { delete this._d[k] },
  }
  container = document.getElementById('root')
  root = createRoot(container)
  AiCoach = (await import('./AiCoach.jsx')).default
})

afterEach(async () => {
  if (root) await act(async () => { root.unmount() })
  root = null; container = null; dom = null
  vi.restoreAllMocks()
})

const mount = async () => { await act(async () => { root.render(React.createElement(AiCoach)) }) }
const byText = text => [...container.querySelectorAll('button')].find(b => b.textContent.trim() === text)
const click = async el => {
  expect(el, 'expected the element to exist').toBeTruthy()
  await act(async () => { el.dispatchEvent(new dom.Event('click', { bubbles: true })) })
}
// linkedom has no value tracker for React's synthetic change system, so a dispatched 'input'
// event never reaches onChange. Calling the handler off the fiber props is the same code path
// React would run, minus the event plumbing that this DOM does not implement.
const propsOf = el => el[Object.keys(el).find(k => k.startsWith('__reactProps'))]
const type = async value => {
  const ta = container.querySelector('textarea')
  await act(async () => { propsOf(ta).onChange({ target: { value } }) })
  return ta
}
const send = async text => {
  await type(text)
  await click(container.querySelector('.aic-send'))
}
const bubbles = () => [...container.querySelectorAll('.aic-b')].map(b => b.textContent.trim())

describe('AI coach screen', () => {
  it('asks for setup instead of a chat box when no key is configured', async () => {
    mocks.cfg = { base: '', key: '', model: '' }
    await mount()
    expect(container.querySelector('textarea')).toBe(null)
    await click(byText('تنظیمات مربی هوشمند') || byText('AI Coach Setup'))
    expect(mocks.sheets).toBe(1)
  })

  it('sends the message and shows the reply', async () => {
    mocks.reply = 'Do 3 sets of 8.'
    await mount()
    await send('what should I do?')
    expect(mocks.requests).toHaveLength(1)
    expect(mocks.requests[0].body.model).toBe('gpt-test')
    expect(bubbles()).toContain('what should I do?')
    expect(bubbles()).toContain('Do 3 sets of 8.')
  })

  it('carries the user plan into the system prompt', async () => {
    mocks.S.routines = [{ id: 'r1', name: 'Push Day', emoji: 'barbell', ex: [] }]
    mocks.S.week = { 1: 'r1' }
    mocks.reply = 'ok'
    await mount()
    await send('review my plan')
    const system = mocks.requests[0].body.messages[0]
    expect(system.role).toBe('system')
    expect(system.content).toContain('Push Day')
    expect(system.content).toContain('Monday=Push Day')
  })

  // The bug: the block was parsed, but the plan never changed.
  it('applies a plan block into routines and the week, then lands on Plan', async () => {
    mocks.reply = 'Here you go.\n\n```opengym\n' + JSON.stringify({
      action: 'create_plan',
      routines: [
        { name: 'Push', glyph: 'barbell', exercises: [{ name: 'barbell bench press', sets: 4, reps: 8 }] },
        { name: 'Pull', glyph: 'pullup', exercises: [{ name: 'barbell bent over row', sets: 4, reps: 8 }] },
      ],
      week: { 1: 'Push', 4: 'Pull' },
    }) + '\n```'

    await mount()
    await send('build me a plan')

    // The JSON is not shown to the user; the prose is.
    expect(bubbles().some(b => b.includes('opengym'))).toBe(false)
    expect(bubbles()).toContain('Here you go.')

    const apply = container.querySelector('.aic-acts button')
    expect(apply).toBeTruthy()
    await click(apply)

    expect(mocks.S.routines.map(r => r.name)).toEqual(['Push', 'Pull'])
    expect(mocks.S.routines[0].ex).toHaveLength(1)
    expect(mocks.S.routines[0].ex[0]).toMatchObject({ sets: 4, reps: 8, mode: 'reps' })
    expect(mocks.S.week[1]).toBe(mocks.S.routines[0].id)
    expect(mocks.S.week[4]).toBe(mocks.S.routines[1].id)

    // Applied state replaces the button, so a double tap cannot create the plan twice.
    expect(container.querySelector('.aic-acts')).toBe(null)
    expect(container.querySelector('.aic-done')).toBeTruthy()

    await act(async () => { await new Promise(r => setTimeout(r, 600)) })
    expect(mocks.navs).toContain('/plan')
  })

  it('adds to an existing routine without touching the others', async () => {
    mocks.S.routines = [
      { id: 'r1', name: 'Push', emoji: 'barbell', ex: [] },
      { id: 'r2', name: 'Pull', emoji: 'pullup', ex: [] },
    ]
    mocks.reply = 'Added.\n```opengym\n' + JSON.stringify({
      action: 'add_exercises', routine: 'Pull',
      exercises: [{ name: 'barbell bent over row', sets: 3, reps: 10 }],
    }) + '\n```'
    await mount()
    await send('add a row to pull')
    await click(container.querySelector('.aic-acts button'))

    expect(mocks.S.routines[0].ex).toHaveLength(0)
    expect(mocks.S.routines[1].ex).toHaveLength(1)
  })

  it('reports a miss instead of silently doing nothing', async () => {
    mocks.reply = '```opengym\n' + JSON.stringify({
      action: 'add_exercises', routine: 'Ghost Day', exercises: [{ name: 'barbell bench press' }],
    }) + '\n```'
    await mount()
    await send('add something')
    await click(container.querySelector('.aic-acts button'))
    expect(mocks.S.routines).toHaveLength(0)
    expect(mocks.toasts.at(-1)).toBeTruthy()
    // Still offered, because nothing was applied.
    expect(container.querySelector('.aic-acts')).toBeTruthy()
  })

  it('shows the provider error text rather than a bare status', async () => {
    mocks.fail = 'Incorrect API key provided'
    await mount()
    await send('hello')
    expect(bubbles().some(b => b.includes('Incorrect API key provided'))).toBe(true)
    expect(container.querySelector('.aic-m.err')).toBeTruthy()
  })

  it('keeps history across a remount', async () => {
    mocks.reply = 'first answer'
    await mount()
    await send('first question')
    await act(async () => { root.unmount() })
    root = createRoot(container)
    await mount()
    expect(bubbles()).toContain('first question')
    expect(bubbles()).toContain('first answer')
  })

  it('sends on Enter but not on Shift+Enter', async () => {
    mocks.reply = 'ok'
    await mount()
    await type('hello')
    await act(async () => { propsOf(container.querySelector('textarea')).onKeyDown({ key: 'Enter', shiftKey: true, preventDefault() {} }) })
    expect(mocks.requests).toHaveLength(0)
    await act(async () => { propsOf(container.querySelector('textarea')).onKeyDown({ key: 'Enter', shiftKey: false, preventDefault() {} }) })
    expect(mocks.requests).toHaveLength(1)
  })

  it('does not send an empty message', async () => {
    await mount()
    await type('   ')
    expect(container.querySelector('.aic-send').disabled).toBe(true)
    // Enter on a blank composer must not fire either.
    await act(async () => { propsOf(container.querySelector('textarea')).onKeyDown({ key: 'Enter', shiftKey: false, preventDefault() {} }) })
    expect(mocks.requests).toHaveLength(0)
  })
})

// The profile is what makes a generated plan specific rather than generic, so the screen has to
// route people through it instead of leaving it as a settings page nobody visits.
describe('the training profile', () => {
  const chip = label => [...container.querySelectorAll('.chip')].find(b => b.textContent.trim() === label)

  it('offers to set it up when it has never been filled in', async () => {
    await mount()
    const btn = byText('پروفایل تمرینی‌ام را تنظیم کن') || byText('Set up my training profile')
    expect(btn).toBeTruthy()
    await click(btn)
    expect(mocks.profileSheets).toHaveLength(1)
  })

  it('offers to edit it once it exists', async () => {
    mocks.S.coach = { _set: true, place: 'gym_full' }
    await mount()
    expect(byText('پروفایل تمرینی‌ام را تنظیم کن') || byText('Set up my training profile')).toBeFalsy()
    expect(byText('ویرایش پروفایل تمرینی') || byText('Edit my training profile')).toBeTruthy()
  })

  it('asks the form first when told to build a plan without one', async () => {
    // Sending this straight to the model is how a beginner with no equipment gets a barbell
    // programme back.
    mocks.reply = 'ok'
    await mount()
    await click(chip('از پروفایلم برنامه بساز') || chip('Build a plan from my profile'))
    expect(mocks.requests).toHaveLength(0)
    expect(mocks.profileSheets).toHaveLength(1)
  })

  it('sends the build request when the form saves', async () => {
    mocks.reply = 'here is your plan'
    await mount()
    await click(chip('از پروفایلم برنامه بساز') || chip('Build a plan from my profile'))
    // The sheet calls back on save; the profile is in state by then.
    mocks.S.coach = { _set: true, place: 'home_none', days: [6, 1, 3] }
    await act(async () => { await mocks.profileSheets[0]() })
    expect(mocks.requests).toHaveLength(1)
    expect(bubbles()).toContain('here is your plan')
  })

  it('goes straight to the model when the profile is already set', async () => {
    mocks.S.coach = { _set: true, place: 'home_none' }
    mocks.reply = 'ok'
    await mount()
    await click(chip('از پروفایلم برنامه بساز') || chip('Build a plan from my profile'))
    expect(mocks.requests).toHaveLength(1)
    expect(mocks.profileSheets).toHaveLength(0)
  })

  it('puts the profile and the equipment-filtered library in the system prompt', async () => {
    mocks.S.coach = {
      _set: true, level: 'beginner', days: [6, 1, 3], place: 'home_none',
      goals: ['fat_loss', 'strength'], sessionMin: 45, limits: ['knee'], notes: 'no burpees',
    }
    mocks.reply = 'ok'
    await mount()
    await send('build me something')
    const system = mocks.requests[0].body.messages[0].content
    expect(system).toContain('Home — no equipment')
    expect(system).toContain('no burpees')
    expect(system).toContain('EXERCISE LIBRARY')
    expect(system).toContain('push-up')
    expect(system.toLowerCase()).not.toContain('barbell bench press')
  })
})

// Six action types now, and they do very different things. A single "Apply this plan" button for
// all of them meant pressing one without knowing whether it added a routine or deleted three.
describe('applying the other action types', () => {
  const actionReply = a => 'Done.\n```opengym\n' + JSON.stringify(a) + '\n```'

  it('rewrites a routine in place rather than appending', async () => {
    mocks.S.routines = [{ id: 'r1', name: 'Full body A', emoji: 'figureStrength', ex: [{ id: '0659', sets: 3, reps: 10, weight: 0, mode: 'reps' }] }]
    mocks.reply = actionReply({
      action: 'update_routine', routine: 'Full body A',
      exercises: [{ name: 'kneeling push-up', sets: 3, reps: 8 }],
    })
    await mount()
    await send('swap the wall push-ups')
    await click(container.querySelector('.aic-acts button'))
    expect(mocks.S.routines).toHaveLength(1)
    expect(mocks.S.routines[0].ex).toHaveLength(1)
    expect(mocks.S.routines[0].ex[0].id).not.toBe('0659')
  })

  it('removes an exercise the user does not want', async () => {
    mocks.S.routines = [{ id: 'r1', name: 'A', emoji: 'figureStrength', ex: [
      { id: '0662', sets: 3, reps: 10 }, { id: '3533', sets: 3, reps: 12 },
    ] }]
    mocks.reply = actionReply({ action: 'remove_exercises', routine: 'A', exercises: ['push-up'] })
    await mount()
    await send('drop the push-ups')
    await click(container.querySelector('.aic-acts button'))
    expect(mocks.S.routines[0].ex).toHaveLength(1)
  })

  it('deletes a routine and clears the day it was on', async () => {
    mocks.S.routines = [{ id: 'r1', name: 'A', emoji: 'figureStrength', ex: [] }]
    mocks.S.week = { 1: 'r1' }
    mocks.reply = actionReply({ action: 'delete_routines', routines: ['A'] })
    await mount()
    await send('delete day A')
    await click(container.querySelector('.aic-acts button'))
    expect(mocks.S.routines).toHaveLength(0)
    expect(mocks.S.week[1]).toBeUndefined()
  })

  it('describes what the block will do before it is applied', async () => {
    mocks.reply = actionReply({
      action: 'create_plan',
      routines: [{ name: 'A', exercises: [{ name: 'push-up', sets: 3, reps: 10 }] }],
      week: { 1: 'A' },
    })
    await mount()
    await send('build')
    // The count comes from the block, not from a fixed label.
    expect(container.querySelector('.aic-acts').textContent).toMatch(/1/)
  })

  it('offers replacing the plan only when there is a plan to replace', async () => {
    mocks.reply = actionReply({
      action: 'create_plan',
      routines: [{ name: 'A', exercises: [{ name: 'push-up', sets: 3, reps: 10 }] }],
    })
    await mount()
    await send('build')
    expect(byText('جای برنامه‌ام بگذار') || byText('Replace my plan')).toBeFalsy()

    mocks.S.routines = [{ id: 'r0', name: 'Old', emoji: 'barbell', ex: [] }]
    await send('build again')
    expect(byText('جای برنامه‌ام بگذار') || byText('Replace my plan')).toBeTruthy()
  })
})
