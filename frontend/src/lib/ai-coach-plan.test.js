import { describe, expect, it } from 'vitest'
import { applyAction, buildSystemPrompt, describeAction, findExercise } from './ai.js'
import { EXIDX } from './exercises.js'
import { modeOf, isPerSide, isBw } from './history.js'
import { policyFor, MAX_BW_SETS } from './progression.js'

// The coach's write path, for the actions and fields added when it became the app's plan builder
// rather than a chat box. ai.test.js covers the transport, name matching and the original three
// actions; this file covers what the profile-driven coach relies on.

const state = (over = {}) => ({
  unit: 'kg', routines: [], week: {}, workouts: [], bodyweight: [], customEx: [],
  targetW: null, coach: null, ...over,
})

const routine = (name, ex = []) => ({ id: name.toLowerCase(), name, emoji: 'figureStrength', ex })
const exOf = (S, rName, i = 0) => S.routines.find(r => r.name === rName).ex[i]

describe('exercise fields the coach may send', () => {
  it('marks unilateral work and keeps the rep total even', () => {
    // reps is the total across both sides, so an odd number puts a rep on one leg and not the
    // other. 15 asked for is 16 stored — 8 a side.
    const S = state()
    applyAction(S, {
      action: 'create_plan',
      routines: [{ name: 'Legs', exercises: [{ name: 'split squats', sets: 3, reps: 15, side: true }] }],
    })
    const e = exOf(S, 'Legs')
    expect(isPerSide(e)).toBe(true)
    expect(e.reps).toBe(16)
  })

  it('accepts a rep ceiling, which is what stops bodyweight work growing forever', () => {
    const S = state()
    applyAction(S, {
      action: 'create_plan',
      routines: [{ name: 'A', exercises: [{ name: 'push-up', sets: 3, reps: 10, repsMax: 18 }] }],
    })
    expect(exOf(S, 'A').repsMax).toBe(18)
  })

  it('ignores a ceiling at or below the working reps', () => {
    // A ceiling under the target trips the add-a-set branch on the very first session.
    const S = state()
    applyAction(S, {
      action: 'create_plan',
      routines: [{ name: 'A', exercises: [
        { name: 'push-up', sets: 3, reps: 12, repsMax: 12 },
        { name: 'bodyweight squat', sets: 3, reps: 12, repsMax: 5 },
      ] }],
    })
    expect(exOf(S, 'A', 0).repsMax).toBeUndefined()
    expect(exOf(S, 'A', 1).repsMax).toBeUndefined()
  })

  it('keeps a unilateral ceiling even too', () => {
    const S = state()
    applyAction(S, {
      action: 'create_plan',
      routines: [{ name: 'A', exercises: [{ name: 'split squats', sets: 3, reps: 16, repsMax: 23, side: true }] }],
    })
    const e = exOf(S, 'A')
    expect(e.repsMax % 2).toBe(0)
    expect(e.repsMax).toBeGreaterThan(e.reps)
  })

  it('builds a timed exercise when given seconds instead of reps', () => {
    // Plank variants are filed as reps in the dataset, so the mode has to follow the model's
    // intent, not the catalogue.
    const S = state()
    applyAction(S, {
      action: 'create_plan',
      routines: [{ name: 'Core', exercises: [{ name: 'power point plank', sets: 3, sec: 40 }] }],
    })
    const e = exOf(S, 'Core')
    expect(modeOf(e)).toBe('time')
    expect(e.sec).toBe(40)
  })

  it('clamps a duration to something a set can be', () => {
    const S = state()
    applyAction(S, {
      action: 'create_plan',
      routines: [{ name: 'Core', exercises: [
        { name: 'power point plank', sets: 3, sec: 99999 },
        { name: 'mountain climber', sets: 3, sec: 0 },
      ] }],
    })
    expect(exOf(S, 'Core', 0).sec).toBeLessThanOrEqual(600)
    expect(exOf(S, 'Core', 1).sec).toBeGreaterThanOrEqual(5)
  })

  it('takes a valid progression policy and rejects one the mode cannot use', () => {
    const S = state()
    applyAction(S, {
      action: 'create_plan',
      routines: [{ name: 'A', exercises: [
        { name: 'push-up', sets: 3, reps: 10, prog: 'double' },
        { name: 'bodyweight squat', sets: 3, reps: 10, prog: 'time' },      // time is for holds
        { name: 'glute bridge', sets: 3, reps: 10, prog: 'telepathy' },
      ] }],
    })
    expect(exOf(S, 'A', 0).prog).toBe('double')
    // An invalid policy must not be written: policyFor would read it, find it unsupported and
    // fall back to 'off' — silently turning automatic progression off altogether.
    expect(policyFor(exOf(S, 'A', 1), null)).not.toBe('off')
    expect(policyFor(exOf(S, 'A', 2), null)).not.toBe('off')
  })

  it('leaves bodyweight exercises carrying no load', () => {
    const S = state()
    applyAction(S, {
      action: 'create_plan',
      routines: [{ name: 'A', exercises: [{ name: 'push-up', sets: 3, reps: 10 }] }],
    })
    const e = exOf(S, 'A')
    expect(isBw(e)).toBe(true)
    expect(e.weight).toBe(0)
  })

  it('accepts added weight when the model asks for it', () => {
    const S = state()
    applyAction(S, {
      action: 'create_plan',
      routines: [{ name: 'A', exercises: [{ name: 'barbell bench press', sets: 3, reps: 8, weight: 60 }] }],
    })
    expect(exOf(S, 'A').weight).toBe(60)
  })

  it('never writes a nonsense number into a config', () => {
    const S = state()
    applyAction(S, {
      action: 'create_plan',
      routines: [{ name: 'A', exercises: [
        { name: 'push-up', sets: 'lots', reps: 'as many as possible', repsMax: 'x', weight: 'heavy' },
      ] }],
    })
    const e = exOf(S, 'A')
    for (const [k, v] of Object.entries(e)) {
      if (typeof v === 'number') expect(Number.isFinite(v), k).toBe(true)
    }
    expect(e.sets).toBeGreaterThanOrEqual(1)
    expect(e.reps).toBeGreaterThanOrEqual(1)
  })
})

describe('update_routine', () => {
  it('replaces the exercise list instead of appending to it', () => {
    // "Swap the wall push-ups for kneeling" used to leave a routine with both, because appending
    // was the only thing the coach could do.
    const S = state({ routines: [routine('Full body A', [{ id: '0659', sets: 3, reps: 10, weight: 0, mode: 'reps' }])] })
    const res = applyAction(S, {
      action: 'update_routine', routine: 'Full body A',
      exercises: [{ name: 'kneeling push-up', sets: 3, reps: 8 }],
    })
    expect(res.ok).toBe(true)
    const r = S.routines[0]
    expect(r.ex).toHaveLength(1)
    expect(EXIDX[r.ex[0].id].n.toLowerCase()).toContain('kneeling')
  })

  it('renames and re-glyphs without touching the exercises', () => {
    const S = state({ routines: [routine('Day A', [{ id: '0662', sets: 3, reps: 10 }])] })
    applyAction(S, { action: 'update_routine', routine: 'Day A', name: 'Push day', glyph: 'legs' })
    expect(S.routines[0].name).toBe('Push day')
    expect(S.routines[0].emoji).toBe('legs')
    expect(S.routines[0].ex).toHaveLength(1)
  })

  it('rejects a glyph the picker does not offer rather than storing it', () => {
    const S = state({ routines: [routine('Day A')] })
    applyAction(S, { action: 'update_routine', routine: 'Day A', glyph: '🦄' })
    expect(S.routines[0].emoji).toBe('figureStrength')
  })

  it('keeps the old list when every new name misses', () => {
    // Wiping the day because of a typo turns a mistake into data loss.
    const S = state({ routines: [routine('Day A', [{ id: '0662', sets: 3, reps: 10 }])] })
    const res = applyAction(S, {
      action: 'update_routine', routine: 'Day A',
      exercises: [{ name: 'qwertyzxcv' }],
    })
    expect(S.routines[0].ex).toHaveLength(1)
    expect(res.unmatched.length).toBe(1)
    expect(res.ok).toBe(false)
  })

  it('says so when the routine does not exist', () => {
    const S = state({ routines: [routine('Day A')] })
    const res = applyAction(S, { action: 'update_routine', routine: 'Leg Day', name: 'x' })
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('no-routine')
  })
})

describe('remove_exercises', () => {
  it('removes by name from that routine only', () => {
    const S = state({
      routines: [
        routine('A', [{ id: '0662', sets: 3, reps: 10 }, { id: '3533', sets: 3, reps: 12 }]),
        routine('B', [{ id: '0662', sets: 3, reps: 10 }]),
      ],
    })
    const res = applyAction(S, { action: 'remove_exercises', routine: 'A', exercises: ['push-up'] })
    expect(res.removed).toBe(1)
    expect(S.routines[0].ex).toHaveLength(1)
    expect(S.routines[1].ex).toHaveLength(1)   // the other routine is untouched
  })

  it('accepts objects as well as bare names', () => {
    const S = state({ routines: [routine('A', [{ id: '3533', sets: 3, reps: 12 }])] })
    const res = applyAction(S, {
      action: 'remove_exercises', routine: 'A',
      exercises: [{ name: EXIDX['3533'].n }],
    })
    expect(res.removed).toBe(1)
  })

  it('reports a name that is not in the routine instead of removing something else', () => {
    // Resolved against the routine's own exercises: matching the whole catalogue would let
    // "remove the row" delete whatever row-like thing scored highest globally.
    const S = state({ routines: [routine('A', [{ id: '3533', sets: 3, reps: 12 }])] })
    const res = applyAction(S, { action: 'remove_exercises', routine: 'A', exercises: ['barbell bench press'] })
    expect(res.removed).toBe(0)
    expect(res.unmatched).toHaveLength(1)
    expect(S.routines[0].ex).toHaveLength(1)
  })
})

describe('delete_routines', () => {
  it('deletes and clears the days that pointed at it', () => {
    // A day holding a deleted id resolves to nothing and reads "Rest day", which looks like the
    // app lost the plan rather than like a deletion.
    const S = state({ routines: [routine('A'), routine('B')], week: { 1: 'a', 3: 'b' } })
    const res = applyAction(S, { action: 'delete_routines', routines: ['A'] })
    expect(res.deleted).toBe(1)
    expect(S.routines.map(r => r.name)).toEqual(['B'])
    expect(S.week[1]).toBeUndefined()
    expect(S.week[3]).toBe('b')
  })

  it('reports a name it cannot find', () => {
    const S = state({ routines: [routine('A')] })
    const res = applyAction(S, { action: 'delete_routines', routines: ['Nope'] })
    expect(res.deleted).toBe(0)
    expect(res.unmatched).toEqual(['Nope'])
    expect(res.ok).toBe(false)
  })
})

describe('the prompt carries the profile', () => {
  it('describes the equipment, days, goals and limits the user chose', () => {
    const S = state({
      coach: {
        _set: true, level: 'beginner', days: [6, 1, 3], place: 'home_none',
        goals: ['fat_loss', 'strength'], sessionMin: 45, limits: ['knee'], notes: 'I hate burpees',
      },
    })
    const p = buildSystemPrompt(S, 'fa')
    expect(p).toContain('TRAINING PROFILE')
    expect(p).toContain('Home — no equipment')
    expect(p).toContain('Saturday, Monday, Wednesday')
    expect(p).toContain('lose fat')
    expect(p).toContain('Knees')
    expect(p).toContain('I hate burpees')
    expect(p).toContain('45 minutes')
  })

  it('admits when the profile is only defaults', () => {
    const p = buildSystemPrompt(state(), 'en')
    expect(p).toContain('defaults')
  })

  it('does not call an answered profile a default', () => {
    const p = buildSystemPrompt(state({ coach: { _set: true, place: 'gym_full' } }), 'en')
    expect(p).not.toContain('the user has not filled this in yet')
  })

  it('lists exercises for the chosen equipment and nothing else', () => {
    const home = buildSystemPrompt(state({ coach: { _set: true, place: 'home_none' } }), 'en')
    expect(home).toContain('EXERCISE LIBRARY')
    expect(home).toContain('push-up')
    expect(home.toLowerCase()).not.toContain('barbell bench press')

    const gym = buildSystemPrompt(state({ coach: { _set: true, place: 'gym_full' } }), 'en')
    expect(gym.toLowerCase()).toContain('barbell')
  })

  it('documents every action the app can actually apply', () => {
    const p = buildSystemPrompt(state(), 'en')
    for (const a of ['create_plan', 'add_exercises', 'update_routine', 'remove_exercises',
      'delete_routines', 'set_week']) {
      expect(p, a).toContain(a)
    }
  })

  it('explains the fields whose absence produces a broken plan', () => {
    const p = buildSystemPrompt(state(), 'en')
    expect(p).toContain('repsMax')
    expect(p).toContain('side')
    expect(p).toContain('prog')
  })

  it('shows the rep ceiling and per-side split of the current plan back to the model', () => {
    // Without these the coach cannot see what it wrote last time and re-proposes it unchanged.
    const S = state({
      routines: [routine('A', [{ id: '3533', sets: 3, reps: 16, repsMax: 24, side: true, mode: 'reps', bodyweight: true }])],
    })
    const p = buildSystemPrompt(S, 'en')
    expect(p).toContain('3x16-24/side')
  })

  it('stays small enough to send on every turn', () => {
    const S = state({ coach: { _set: true, place: 'gym_full' } })
    expect(buildSystemPrompt(S, 'fa').length / 4).toBeLessThan(3000)
  })
})

describe('describeAction', () => {
  it('labels each action differently, so the button says what it will do', () => {
    const labels = ['create_plan', 'add_exercises', 'update_routine', 'remove_exercises',
      'delete_routines', 'set_week'].map(a => describeAction({ action: a }).label)
    expect(new Set(labels).size).toBe(labels.length)
  })

  it('counts what is in the block', () => {
    const d = describeAction({ action: 'create_plan', routines: [{}, {}, {}], week: { 1: 'a' } })
    expect(d.detail).toContain(3)
  })

  it('has a label for an action it does not know', () => {
    expect(describeAction({ action: 'nonsense' }).label).toBeTruthy()
    expect(describeAction(null).label).toBeTruthy()
  })
})

describe('a whole plan the coach might write', () => {
  it('produces routines the workout screen and the progression engine can both read', () => {
    const S = state({ coach: { _set: true, place: 'home_none', days: [6, 1, 3] } })
    const res = applyAction(S, {
      action: 'create_plan',
      routines: [
        { name: 'Full body A', glyph: 'figureStrength', exercises: [
          { name: 'bodyweight squat', sets: 3, reps: 12, repsMax: 20 },
          { name: 'kneeling push-up', sets: 3, reps: 8, repsMax: 15 },
          { name: 'bodyweight standing row', sets: 3, reps: 12, repsMax: 20 },
          { name: 'power point plank', sets: 3, sec: 30 },
        ] },
        { name: 'Full body B', glyph: 'legs', exercises: [
          { name: 'split squats', sets: 3, reps: 16, repsMax: 24, side: true },
          { name: 'push-up (wall)', sets: 3, reps: 10, repsMax: 18 },
          { name: 'dead bug', sets: 3, reps: 16, side: true },
        ] },
      ],
      week: { 6: 'Full body A', 1: 'Full body B' },
    })

    expect(res.ok).toBe(true)
    expect(res.created).toHaveLength(2)
    expect(res.unmatched).toEqual([])
    expect(res.scheduled).toBe(2)

    for (const r of S.routines) {
      expect(r.ex.length).toBeGreaterThan(0)
      for (const e of r.ex) {
        expect(EXIDX[e.id], 'every id resolves').toBeTruthy()
        // Progression has to be live, or the plan never updates itself — the feature the whole
        // coach exists to drive.
        expect(policyFor(e, r, modeOf(e)), EXIDX[e.id].n).not.toBe('off')
        if (modeOf(e) === 'reps') {
          expect(e.sets).toBeLessThan(MAX_BW_SETS)
          if (isPerSide(e)) expect(e.reps % 2).toBe(0)
        }
      }
    }
    // Scheduled onto the days in the profile.
    expect(S.week[6]).toBe(S.routines[0].id)
    expect(S.week[1]).toBe(S.routines[1].id)
  })

  it('picks only equipment-free exercises when told the names from a home digest', () => {
    const S = state()
    applyAction(S, {
      action: 'create_plan',
      routines: [{ name: 'A', exercises: [
        { name: 'bodyweight squat' }, { name: 'push-up' }, { name: 'glute bridge' },
        { name: 'mountain climber' }, { name: 'dead bug' },
      ] }],
    })
    for (const e of S.routines[0].ex) {
      expect(EXIDX[e.id].eq, EXIDX[e.id].n).toBe('body weight')
    }
  })
})
