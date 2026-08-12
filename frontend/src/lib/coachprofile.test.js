import { describe, expect, it } from 'vitest'
import {
  DEF_PROFILE, LEVELS, PLACES, GOALS, LIMITS,
  getProfile, hasProfile, equipmentFor, avoidMuscles, exercisesForTime,
} from './coachprofile.js'
import { EXDB } from './exercises.js'

describe('profile defaults', () => {
  it('is usable before the user has answered anything', () => {
    const p = getProfile({})
    expect(LEVELS).toContain(p.level)
    expect(PLACES[p.place]).toBeTruthy()
    expect(p.days.length).toBeGreaterThan(0)
    expect(p.goals.length).toBeGreaterThan(0)
    expect(p.sessionMin).toBeGreaterThan(0)
  })

  it('overlays saved answers on the defaults, so a partial profile is still complete', () => {
    const p = getProfile({ coach: { place: 'gym_full' } })
    expect(p.place).toBe('gym_full')
    expect(p.sessionMin).toBe(DEF_PROFILE.sessionMin)
    expect(p.days).toEqual(DEF_PROFILE.days)
  })

  it('distinguishes an answered profile from the defaults', () => {
    // The prompt labels an unanswered profile as guesses; without this flag it would present
    // "beginner, home, no equipment" as something the user said.
    expect(hasProfile({})).toBe(false)
    expect(hasProfile({ coach: { place: 'gym_full' } })).toBe(false)
    expect(hasProfile({ coach: { place: 'gym_full', _set: true } })).toBe(true)
  })
})

describe('equipment', () => {
  it('names only equipment values the dataset actually uses', () => {
    // A typo here silently empties the pool for that place, and the coach then has nothing to
    // pick from — the exercise list in the prompt just goes short.
    const real = new Set(EXDB.map(e => e.eq))
    for (const [place, { eq }] of Object.entries(PLACES)) {
      if (!eq) continue
      for (const v of eq) expect(real.has(v), `${place}: "${v}" is not an equipment value`).toBe(true)
    }
  })

  it('leaves a full gym unrestricted', () => {
    expect(equipmentFor({ place: 'gym_full' })).toBe(null)
  })

  it('restricts an empty home to bodyweight', () => {
    const eq = equipmentFor({ place: 'home_none' })
    expect(eq).toContain('body weight')
    expect(eq).not.toContain('barbell')
    expect(eq).not.toContain('dumbbell')
  })

  it('lets dumbbells in but not barbells at home', () => {
    const eq = equipmentFor({ place: 'home_basic' })
    expect(eq).toContain('dumbbell')
    expect(eq).toContain('band')
    expect(eq).not.toContain('barbell')
    expect(eq).not.toContain('leverage machine')
  })

  it('falls back to the safest option for an unknown place', () => {
    expect(equipmentFor({ place: 'spaceship' })).toEqual(PLACES.home_none.eq)
  })
})

describe('injury limits', () => {
  it('maps to muscle names the dataset targets', () => {
    const real = new Set(EXDB.map(e => e.tg))
    for (const [k, { muscles }] of Object.entries(LIMITS)) {
      for (const m of muscles) expect(real.has(m), `${k}: "${m}" is not a target muscle`).toBe(true)
    }
  })

  it('is empty when nothing is flagged', () => {
    expect(avoidMuscles({ limits: [] })).toEqual([])
    expect(avoidMuscles({})).toEqual([])
  })

  it('merges the muscles of several flags without duplicates', () => {
    const m = avoidMuscles({ limits: ['knee', 'hip'] })
    expect(m).toContain('quads')
    expect(m).toContain('glutes')
    expect(new Set(m).size).toBe(m.length)
  })

  it('ignores a flag it does not know', () => {
    expect(avoidMuscles({ limits: ['elbow_of_doom'] })).toEqual([])
  })
})

describe('exercisesForTime', () => {
  it('gives a short session fewer exercises than a long one', () => {
    expect(exercisesForTime(30)).toBeLessThan(exercisesForTime(90))
  })

  it('stays within a range a session can actually contain', () => {
    for (const min of [1, 20, 45, 60, 120, 600]) {
      const n = exercisesForTime(min)
      expect(n).toBeGreaterThanOrEqual(3)
      expect(n).toBeLessThanOrEqual(10)
    }
  })

  it('handles junk input rather than producing NaN in the prompt', () => {
    for (const v of [null, undefined, 'abc', {}]) {
      expect(Number.isFinite(exercisesForTime(v))).toBe(true)
    }
  })

  it('puts a 45-minute session in a sane range', () => {
    const n = exercisesForTime(45)
    expect(n).toBeGreaterThanOrEqual(4)
    expect(n).toBeLessThanOrEqual(7)
  })
})

describe('goals', () => {
  it('offers fat loss and strength, which is what most people ask for', () => {
    expect(GOALS).toContain('fat_loss')
    expect(GOALS).toContain('strength')
  })
})
