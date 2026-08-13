// The AI coach's newer capabilities: what it can read, and the four things it can now write.
//
// Split from ai.test.js because these are a different kind of test. That file pins the
// transport and the plan-writing; this one pins the two bugs found by probing applyAction
// directly, and the settings/weigh-in/date-override actions added alongside them.
//
// The two bugs were both silent WRONG writes reported as success, which is worse than a
// failure — the user is told it worked and has no reason to check.

import { describe, expect, it } from 'vitest'
import { applyAction, buildSystemPrompt, describeAction, isISODate } from './ai.js'
import { effortOf } from './history.js'
import { effectiveRoutineId } from './history.js'

const state = (over = {}) => ({
  unit: 'kg', restSec: 90, sound: true, keepAwake: true, effort: null,
  routines: [], week: {}, dayPlan: {}, workouts: [], bodyweight: [], customEx: [],
  targetW: null, ...over,
})

const routine = (id, name) => ({ id, name, emoji: 'figureStrength', ex: [] })

describe('routine matching', () => {
  // The bug: the fallback was a bare two-way substring test, so norm('A') === 'a' matched
  // 'back day' via .includes('a'). The coach names days "Full body A"/"Full body B" and
  // refers to them as "A"/"B" in later turns, so this wrote into the wrong routine and
  // reported ok.
  it('does not resolve "A" to "Back day" when "Full body A" exists', () => {
    const S = state({ routines: [routine('r1', 'Back day'), routine('r2', 'Full body A')] })
    const res = applyAction(S, {
      action: 'add_exercises', routine: 'A',
      exercises: [{ name: 'push-up', sets: 3, reps: 10 }],
    })
    expect(res.ok).toBe(true)
    expect(S.routines[0].ex).toHaveLength(0)      // Back day untouched
    expect(S.routines[1].ex).toHaveLength(1)      // Full body A got it
  })

  it('still matches a whole word, and an exact name wins over any partial', () => {
    const S = state({ routines: [routine('r1', 'Upper body'), routine('r2', 'Upper')] })
    applyAction(S, { action: 'add_exercises', routine: 'Upper', exercises: [{ name: 'push-up', sets: 3, reps: 10 }] })
    expect(S.routines[1].ex).toHaveLength(1)
    expect(S.routines[0].ex).toHaveLength(0)
  })

  it('reports the name it could not find instead of a bare failure', () => {
    const S = state({ routines: [routine('r1', 'Push')] })
    const res = applyAction(S, { action: 'add_exercises', routine: 'Ghost Day', exercises: [{ name: 'push-up' }] })
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('no-routine')
    expect(res.name).toBe('Ghost Day')
  })

  it('names an action type it does not have, so the UI can say which', () => {
    const res = applyAction(state(), { action: 'set_rest_timer', sec: 120 })
    expect(res.reason).toBe('unknown-action')
    expect(res.name).toBe('set_rest_timer')
  })
})

describe('deleting a routine cleans every reference to it', () => {
  // dayPlan is read BEFORE the weekly plan (effectiveRoutineId), so a stale override is
  // worse than a stale week entry: the date reads Rest even after the weekday is
  // rescheduled, and nothing in the UI explains why.
  it('drops date overrides pointing at the deleted routine', () => {
    const S = state({
      routines: [routine('r1', 'A'), routine('r2', 'B')],
      week: { 1: 'r1' },
      dayPlan: { '2026-08-20': 'r1', '2026-08-21': 'rest', '2026-08-22': 'r2' },
    })
    applyAction(S, { action: 'delete_routines', routines: ['A'] })

    expect(S.week[1]).toBeUndefined()
    expect(S.dayPlan['2026-08-20']).toBeUndefined()   // was the deleted routine
    expect(S.dayPlan['2026-08-21']).toBe('rest')      // an explicit rest day is the user's, keep it
    expect(S.dayPlan['2026-08-22']).toBe('r2')        // unrelated override untouched
  })

  it('a replaced plan does not leave dates pointing at the old routines', () => {
    const S = state({
      routines: [routine('r1', 'Old')],
      week: { 1: 'r1' },
      dayPlan: { '2026-08-20': 'r1' },
    })
    applyAction(S, {
      action: 'create_plan',
      routines: [{ name: 'New', exercises: [{ name: 'push-up', sets: 3, reps: 10 }] }],
    }, { replace: true })

    expect(S.dayPlan['2026-08-20']).toBeUndefined()
    // and the date now falls through to the weekly plan rather than reading Rest
    expect(effectiveRoutineId(S, '2026-08-20')).toBe(S.week[new Date('2026-08-20T12:00:00').getDay()] || null)
  })
})

describe('plan_day', () => {
  it('overrides a specific date with a routine, a rest, or nothing', () => {
    const S = state({ routines: [routine('r1', 'Full body A')], dayPlan: { '2026-09-03': 'r1' } })
    const res = applyAction(S, {
      action: 'plan_day',
      dates: { '2026-09-01': 'Full body A', '2026-09-02': 'rest', '2026-09-03': 'clear' },
    })
    expect(res.ok).toBe(true)
    expect(res.dated).toBe(3)
    expect(S.dayPlan['2026-09-01']).toBe('r1')
    expect(S.dayPlan['2026-09-02']).toBe('rest')
    expect(S.dayPlan['2026-09-03']).toBeUndefined()
  })

  it('rejects a date that is not a real calendar date', () => {
    const S = state({ routines: [routine('r1', 'A')] })
    const res = applyAction(S, { action: 'plan_day', dates: { '2026-02-30': 'A', 'tomorrow': 'A', '2026-13-01': 'A' } })
    expect(S.dayPlan).toEqual({})
    expect(res.unmatched).toEqual(['2026-02-30', 'tomorrow', '2026-13-01'])
  })

  it('reports an unknown routine name rather than writing a bad id', () => {
    const S = state({ routines: [routine('r1', 'A')] })
    const res = applyAction(S, { action: 'plan_day', dates: { '2026-09-01': 'Nonexistent Day' } })
    expect(S.dayPlan).toEqual({})
    expect(res.unmatched).toContain('Nonexistent Day')
  })
})

describe('set_settings', () => {
  it('writes the settings it is given and reports how many changed', () => {
    const S = state()
    const res = applyAction(S, { action: 'set_settings', restSec: 120, effort: 'rir', sound: false, keepAwake: false })
    expect(res.ok).toBe(true)
    expect(res.settings).toBe(4)
    expect(S.restSec).toBe(120)
    expect(effortOf(S)).toBe('rir')
    expect(S.sound).toBe(false)
    expect(S.keepAwake).toBe(false)
  })

  it('clamps the rest timer instead of writing an absurd value', () => {
    const S = state()
    applyAction(S, { action: 'set_settings', restSec: 99999 })
    expect(S.restSec).toBe(600)
    applyAction(S, { action: 'set_settings', restSec: -5 })
    expect(S.restSec).toBe(15)
  })

  it('ignores an effort scale the app does not have', () => {
    const S = state()
    const res = applyAction(S, { action: 'set_settings', effort: 'rpe10' })
    expect(res.ok).toBe(false)
    expect(effortOf(S)).toBe('none')
  })

  it('clears the legacy showRir flag when it sets the scale', () => {
    // effortOf falls back to showRir when `effort` has no answer, so leaving it set would
    // switch the column back on the next time state is merged over DEF.
    const S = state({ showRir: true })
    applyAction(S, { action: 'set_settings', effort: 'none' })
    expect(S.showRir).toBeUndefined()
    expect(effortOf(S)).toBe('none')
  })

  it('accepts only kg and lb for the unit', () => {
    const S = state()
    applyAction(S, { action: 'set_settings', unit: 'stone' })
    expect(S.unit).toBe('kg')
    applyAction(S, { action: 'set_settings', unit: 'lb' })
    expect(S.unit).toBe('lb')
  })

  it('reports nothing when every value already matches', () => {
    const S = state({ restSec: 90, sound: true })
    const res = applyAction(S, { action: 'set_settings', restSec: 90, sound: true })
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('nothing')
  })

  it('ignores keys that are not in the writable set', () => {
    const S = state()
    applyAction(S, { action: 'set_settings', theme: 'light', lang: 'en', accent: 'pink' })
    expect(S.theme).toBeUndefined()
    expect(S.lang).toBeUndefined()
    expect(S.accent).toBeUndefined()
  })
})

describe('log_bodyweight and set_goal', () => {
  it('logs a weigh-in in the same shape the manual sheet writes', () => {
    const S = state()
    const res = applyAction(S, { action: 'log_bodyweight', weight: 82.44, date: '2026-08-10' })
    expect(res.logged).toBe(1)
    expect(S.bodyweight).toHaveLength(1)
    expect(S.bodyweight[0]).toMatchObject({ d: '2026-08-10', w: 82.4 })
    expect(typeof S.bodyweight[0].t).toBe('number')
  })

  it('updates the existing entry rather than adding a second one for the same day', () => {
    const S = state({ bodyweight: [{ d: '2026-08-10', w: 80, t: 1 }] })
    applyAction(S, { action: 'log_bodyweight', weight: 81, date: '2026-08-10' })
    expect(S.bodyweight).toHaveLength(1)
    expect(S.bodyweight[0].w).toBe(81)
  })

  it('keeps the log in date order for the chart', () => {
    const S = state({ bodyweight: [{ d: '2026-08-10', w: 80, t: 1 }] })
    applyAction(S, { action: 'log_bodyweight', weight: 79, date: '2026-08-01' })
    expect(S.bodyweight.map(b => b.d)).toEqual(['2026-08-01', '2026-08-10'])
  })

  it('refuses a weight that is a unit mix-up or a typo', () => {
    const S = state()
    for (const w of [0, 5, 900, 'heavy', null]) {
      const res = applyAction(S, { action: 'log_bodyweight', weight: w })
      expect(res.ok).toBe(false)
    }
    expect(S.bodyweight).toHaveLength(0)
  })

  it('sets and clears the body weight goal', () => {
    const S = state()
    applyAction(S, { action: 'set_goal', weight: 75 })
    expect(S.targetW).toBe(75)
    const res = applyAction(S, { action: 'set_goal', weight: null })
    expect(res.goal).toBe(1)
    expect(S.targetW).toBe(null)
  })

  it('treats a zero goal as clearing it, not as a target of zero', () => {
    const S = state({ targetW: 80 })
    applyAction(S, { action: 'set_goal', weight: 0 })
    expect(S.targetW).toBe(null)
  })
})

describe('isISODate', () => {
  it('accepts real dates and rejects the shape-only ones', () => {
    expect(isISODate('2026-08-13')).toBe(true)
    expect(isISODate('2024-02-29')).toBe(true)     // leap year
    expect(isISODate('2026-02-30')).toBe(false)    // rolls over to March
    expect(isISODate('2026-13-01')).toBe(false)
    expect(isISODate('26-08-13')).toBe(false)
    expect(isISODate('')).toBe(false)
    expect(isISODate(null)).toBe(false)
  })
})

describe('describeAction covers every action the prompt documents', () => {
  it('names the settings being changed rather than counting them', () => {
    const d = describeAction({ action: 'set_settings', restSec: 120, unit: 'lb' })
    expect(d.label).toBe('Change settings')
    // Separate keys, not a joined string: each one goes through t() on its own, or the names
    // stay in English inside a translated line.
    expect(d.parts).toEqual(['Rest timer', 'Weight unit'])
  })

  it('hands a raw weight back in its own field rather than as a template argument', () => {
    expect(describeAction({ action: 'log_bodyweight', weight: 82.4 }).value).toBe('82.4')
    expect(describeAction({ action: 'set_goal', weight: 75 }).value).toBe('75')
  })

  it('distinguishes setting a goal from clearing one', () => {
    expect(describeAction({ action: 'set_goal', weight: 75 }).label).toBe('Set this goal')
    expect(describeAction({ action: 'set_goal', weight: null }).label).toBe('Clear the goal')
  })

  it('has a real label for every documented action', () => {
    for (const action of ['create_plan', 'update_routine', 'add_exercises', 'remove_exercises',
      'delete_routines', 'set_week', 'plan_day', 'set_settings', 'log_bodyweight', 'set_goal']) {
      expect(describeAction({ action }).label).not.toBe('Apply')
    }
  })
})

describe('what the coach can read', () => {
  const NOW = Date.parse('2026-08-13T09:00:00Z')
  const day = n => new Date(NOW - n * 86400000).toISOString().slice(0, 10)

  // A bench press session yesterday: chest is fatigued, legs have had nothing.
  const withHistory = () => state({
    routines: [{ id: 'r1', name: 'Push', emoji: 'barbell', ex: [{ id: '0025', sets: 3, reps: 8, weight: 60, mode: 'reps', prog: 'linear' }] }],
    week: { 1: 'r1' },
    workouts: [{
      d: day(1), start: NOW - 86400000, rid: 'r1',
      entries: [{ id: '0025', sets: [{ done: true, w: 60, r: 8 }, { done: true, w: 60, r: 8 }, { done: true, w: 60, r: 8 }] }],
    }],
  })

  it('includes per-muscle fatigue and retention from the log', () => {
    const p = buildSystemPrompt(withHistory(), 'fa', NOW)
    expect(p).toContain('RECOVERY')
    expect(p).toContain('fatigued right now')
    expect(p).toContain('losing retention')
    expect(p).toContain('sets per muscle, last 30 days')
  })

  it('says plainly that there is nothing to go on when the log is empty', () => {
    const p = buildSystemPrompt(state(), 'fa', NOW)
    expect(p).toContain('No logged workouts yet')
  })

  it('tells the coach which exercises the app is already progressing', () => {
    const p = buildSystemPrompt(withHistory(), 'fa', NOW)
    expect(p).toContain('AUTOMATIC PROGRESSION ALREADY RUNNING')
    expect(p).toContain('Linear progression')
    expect(p).toContain('last session hit the target')
  })

  it('omits the progression block entirely when no exercise has a policy', () => {
    const S = state({ routines: [{ id: 'r1', name: 'A', emoji: 'x', ex: [{ id: '0025', sets: 3, reps: 8, mode: 'reps', prog: 'off' }] }] })
    expect(buildSystemPrompt(S, 'fa', NOW)).not.toContain('AUTOMATIC PROGRESSION')
  })

  it('shows the settings it is allowed to change, with their current values', () => {
    const S = state({ restSec: 150, sound: false, effort: 'rpe' })
    const p = buildSystemPrompt(S, 'fa', NOW)
    expect(p).toContain('rest timer: 150s')
    expect(p).toContain('effort scale logged per set: rpe')
    expect(p).toContain('sounds: off')
  })

  it('documents every action applyAction implements', () => {
    const p = buildSystemPrompt(state(), 'fa', NOW)
    for (const a of ['create_plan', 'update_routine', 'add_exercises', 'remove_exercises',
      'delete_routines', 'set_week', 'plan_day', 'set_settings', 'log_bodyweight', 'set_goal']) {
      expect(p).toContain(a)
    }
  })

  it('is deterministic for a fixed now', () => {
    const S = withHistory()
    expect(buildSystemPrompt(S, 'fa', NOW)).toBe(buildSystemPrompt(S, 'fa', NOW))
  })
})
