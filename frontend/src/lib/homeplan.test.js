import { describe, expect, it } from 'vitest'
import { homeRoutines, HOME_DAYS } from './homeplan.js'
import { EXIDX } from './exercises.js'
import { modeOf, isPerSide } from './history.js'
import { policyFor, MAX_BW_SETS } from './progression.js'

// The point of this plan is that it can be done in an empty room. Anything that needs a bar, a
// bench or a box makes the whole plan undoable, and the failure is silent — the exercise renders
// perfectly, you just cannot perform it. So the equipment claim is asserted, not trusted.
const NEEDS_KIT = /\b(bar|bench|box|cage|parallel bars|staircase|suspension|rings?|ring)\b/i

describe('home plan', () => {
  const routines = homeRoutines()

  it('has three days, one routine each', () => {
    expect(routines).toHaveLength(3)
    expect(HOME_DAYS).toHaveLength(3)
  })

  it('spaces the three days out with rest between them', () => {
    // Sat / Mon / Wed — never two sessions back to back, which is what a beginner recovers from.
    const sorted = [...HOME_DAYS].sort((a, b) => a - b)
    expect(new Set(sorted).size).toBe(3)
    const asWeek = sorted.map(d => (d === 0 ? 7 : d))   // Mon-first
    asWeek.sort((a, b) => a - b)
    for (let i = 1; i < asWeek.length; i++) {
      expect(asWeek[i] - asWeek[i - 1]).toBeGreaterThanOrEqual(2)
    }
  })

  it('every exercise exists in the catalogue', () => {
    for (const r of routines) {
      for (const e of r.ex) expect(EXIDX[e.id], `${r.name}: unknown id ${e.id}`).toBeTruthy()
    }
  })

  it('needs no equipment at all', () => {
    for (const r of routines) {
      for (const e of r.ex) {
        const ex = EXIDX[e.id]
        expect(ex.eq, `${ex.n} is ${ex.eq}`).toBe('body weight')
        expect(NEEDS_KIT.test(ex.n), `${ex.n} implies equipment`).toBe(false)
      }
    }
  })

  it('gives every exercise a working progression rule', () => {
    for (const r of routines) {
      for (const e of r.ex) {
        const policy = policyFor(e, r, modeOf(e))
        expect(policy, `${EXIDX[e.id].n}`).not.toBe('off')
      }
    }
  })

  it('caps rep growth so a set never runs away', () => {
    // Without repsMax the bodyweight branch adds a rep forever; with it, the reps reset and a
    // set is added instead. The ceiling also has to be reachable in fewer than MAX_BW_SETS.
    for (const r of routines) {
      for (const e of r.ex) {
        if (modeOf(e) !== 'reps') continue
        expect(e.repsMax, `${EXIDX[e.id].n} has no ceiling`).toBeGreaterThan(e.reps)
        expect(e.sets).toBeLessThan(MAX_BW_SETS)
      }
    }
  })

  it('keeps unilateral rep totals even', () => {
    for (const r of routines) {
      for (const e of r.ex) {
        if (!isPerSide(e)) continue
        expect(e.reps % 2, `${EXIDX[e.id].n}: ${e.reps} splits unevenly`).toBe(0)
        expect(e.repsMax % 2, `${EXIDX[e.id].n}: ceiling ${e.repsMax} splits unevenly`).toBe(0)
      }
    }
  })

  it('marks every entry as carrying no load', () => {
    // The weight prompt is what makes a bodyweight exercise annoying to log, and progression.js
    // reads the logged weight to decide it should progress reps instead of kilos.
    for (const r of routines) {
      for (const e of r.ex) {
        expect(e.bodyweight, `${EXIDX[e.id].n}`).toBe(true)
        expect(e.weight).toBe(0)
      }
    }
  })

  it('trains push, pull, legs and core on every single day', () => {
    // Three full-body days is the whole reason this plan is not a split: at 3×/week a split
    // would train each pattern once every 7 days.
    const PATTERNS = {
      push: ['pectorals', 'triceps', 'delts'],
      pull: ['upper back', 'lats', 'biceps', 'traps'],
      legs: ['quads', 'glutes', 'hamstrings', 'calves'],
      core: ['abs', 'spine']
    }
    for (const r of routines) {
      const targets = r.ex.map(e => EXIDX[e.id].tg)
      for (const [pattern, tgs] of Object.entries(PATTERNS)) {
        expect(targets.some(x => tgs.includes(x)), `${r.name} has no ${pattern}`).toBe(true)
      }
    }
  })

  it('includes timed conditioning work for the fat-loss half of the goal', () => {
    const timed = routines.flatMap(r => r.ex).filter(e => modeOf(e) === 'time')
    expect(timed.length).toBeGreaterThan(0)
    for (const e of timed) expect(e.sec).toBeGreaterThan(0)
  })

  it('hands out fresh ids on every call', () => {
    const a = homeRoutines(), b = homeRoutines()
    expect(a.map(r => r.id)).not.toEqual(b.map(r => r.id))
    expect(new Set(a.map(r => r.id)).size).toBe(3)
  })

  it('never shows a muscle name where a movement name belongs', () => {
    // id 3533 ships as "quads" upstream. Left alone, the first line of day one reads as a body
    // part, which is indistinguishable from a bug on screen. lib/exercises.js renames it.
    const MUSCLES = ['quads', 'glutes', 'hamstrings', 'calves', 'abs', 'lats', 'pectorals',
      'triceps', 'biceps', 'delts', 'traps', 'spine', 'upper back']
    for (const r of routines) {
      for (const e of r.ex) {
        const ex = EXIDX[e.id]
        expect(MUSCLES.includes(ex.n.toLowerCase()), `${e.id} is named "${ex.n}"`).toBe(false)
        expect(ex.n.toLowerCase()).not.toBe(ex.tg.toLowerCase())
      }
    }
  })

  it('names every routine and gives it a real icon', () => {
    for (const r of routines) {
      expect(r.name.length).toBeGreaterThan(0)
      expect(r.emoji).toBeTruthy()
    }
  })
})
