import { describe, expect, it } from 'vitest'
import { poolFor, catalogDigest } from './coachcatalog.js'
import { DEF_PROFILE } from './coachprofile.js'
import { EXDB } from './exercises.js'
import { findExercise } from './ai.js'

const profile = patch => ({ ...DEF_PROFILE, ...patch })

describe('poolFor', () => {
  it('gives an empty home only bodyweight work', () => {
    for (const e of poolFor(profile({ place: 'home_none' }))) {
      expect(['body weight', 'assisted'], e.n).toContain(e.eq)
    }
  })

  it('excludes bodyweight exercises whose name needs equipment', () => {
    // The dataset files pull-ups, dips and inverted rows as "body weight". They are, and they are
    // also impossible in an empty room — and they are exactly what a model picks for a bodyweight
    // back day. This filter is the reason the generated plan is doable.
    const names = poolFor(profile({ place: 'home_none' })).map(e => e.n.toLowerCase())
    for (const bad of ['pull-up', 'chin-up', 'inverted row', 'triceps dip', 'bench dip',
      'muscle up', 'incline push-up', 'suspended push-up']) {
      expect(names, bad).not.toContain(bad)
    }
  })

  it('keeps the movements that genuinely need nothing', () => {
    const names = poolFor(profile({ place: 'home_none' })).map(e => e.n.toLowerCase())
    for (const good of ['push-up', 'bodyweight squat', 'glute bridge', 'mountain climber',
      'dead bug', 'split squats', 'walking lunge']) {
      expect(names, good).toContain(good)
    }
  })

  it('lets dumbbell work in for a home with dumbbells', () => {
    const eqs = new Set(poolFor(profile({ place: 'home_basic' })).map(e => e.eq))
    expect(eqs.has('dumbbell')).toBe(true)
    expect(eqs.has('barbell')).toBe(false)
  })

  it('restricts nothing for a full gym', () => {
    const pool = poolFor(profile({ place: 'gym_full' }))
    const eqs = new Set(pool.map(e => e.eq))
    expect(eqs.has('barbell')).toBe(true)
    expect(eqs.has('leverage machine')).toBe(true)
    expect(pool.length).toBeGreaterThan(1000)
  })

  it('drops exercises that primarily load a flagged joint', () => {
    const pool = poolFor(profile({ place: 'gym_full', limits: ['lower_back'] }))
    expect(pool.some(e => e.tg === 'spine')).toBe(false)
    // But it must not empty out: excluding everything that mentions the area as a *secondary*
    // muscle would remove most of the lower body.
    expect(pool.length).toBeGreaterThan(1000)
  })

  it('still leaves a trainable pool when several areas are flagged', () => {
    const pool = poolFor(profile({ place: 'home_none', limits: ['knee', 'lower_back', 'shoulder'] }))
    expect(pool.length).toBeGreaterThan(30)
    expect(pool.some(e => e.tg === 'quads')).toBe(false)
  })

  it('excludes stretches and mobility work, which are not training', () => {
    const names = poolFor(profile({ place: 'gym_full' })).map(e => e.n.toLowerCase())
    // \bstretch\b, so "outstretched leg" is still a real exercise.
    expect(names.some(n => /\bstretch(es|ing)?\b/.test(n))).toBe(false)
  })

  it('excludes gymnastics skills a beginner cannot be prescribed', () => {
    // Planches and one-arm push-ups are unweighted, so they pass every equipment filter, and
    // their short plain names score well on the ranking — they land near the top of the digest
    // unless excluded explicitly.
    const names = poolFor(profile({ place: 'home_none' })).map(e => e.n.toLowerCase())
    for (const bad of ['full planche', 'front lever', 'handstand push-up', 'single arm push-up',
      'l-sit on floor', 'flag', 'sissy squat']) {
      expect(names, bad).not.toContain(bad)
    }
  })
})

describe('catalogDigest', () => {
  it('lists exercises grouped by muscle', () => {
    const d = catalogDigest(profile({ place: 'home_none' }))
    expect(d).toMatch(/^quads: /m)
    expect(d).toMatch(/^pectorals: /m)
    expect(d).toContain('bodyweight squat')
  })

  it('stays small enough to send on every turn', () => {
    // This goes into the system prompt of every single message. The full catalogue is ~9.5k
    // tokens; anything of that order is paid for again on each turn of the conversation.
    for (const place of ['home_none', 'home_basic', 'gym_full']) {
      const d = catalogDigest(profile({ place }))
      expect(d.length / 4, place).toBeLessThan(2200)
    }
  })

  it('names nothing the user cannot do', () => {
    const d = catalogDigest(profile({ place: 'home_none' })).toLowerCase()
    for (const bad of ['barbell', 'dumbbell', 'cable', 'machine', 'pull-up', 'bench']) {
      expect(d, bad).not.toContain(bad)
    }
  })

  it('lists no exercise twice in the same line', () => {
    // The dataset has three entries called "self assisted inverse leg curl". Two identical names
    // in a prompt is a wasted slot and an ambiguous instruction.
    for (const line of catalogDigest(profile({ place: 'home_none' })).split('\n')) {
      const names = line.slice(line.indexOf(': ') + 2).split(', ')
      expect(new Set(names).size, line).toBe(names.length)
    }
  })

  it('names only exercises that resolve back to a real one', () => {
    // The whole point of handing the model a list is that what it echoes back is findable. If a
    // digest name does not round-trip through findExercise, the plan silently loses that row.
    const d = catalogDigest(profile({ place: 'home_none' }))
    const names = d.split('\n').flatMap(l => l.slice(l.indexOf(': ') + 2).split(', '))
    expect(names.length).toBeGreaterThan(50)
    for (const n of names) {
      const hit = findExercise(n, EXDB)
      expect(hit, `"${n}" does not resolve`).toBeTruthy()
      expect(hit.n.toLowerCase(), `"${n}" resolved to "${hit && hit.n}"`).toBe(n.toLowerCase())
    }
  })

  it('covers every movement pattern a plan needs', () => {
    // A digest missing a push or a pull produces a plan missing one.
    const d = catalogDigest(profile({ place: 'home_none' }))
    for (const tg of ['quads', 'glutes', 'pectorals', 'upper back', 'abs', 'triceps']) {
      expect(d, tg).toContain(tg + ': ')
    }
  })

  it('reacts to the equipment answer', () => {
    const home = catalogDigest(profile({ place: 'home_none' }))
    const gym = catalogDigest(profile({ place: 'gym_full' }))
    expect(home).not.toEqual(gym)
    expect(gym.toLowerCase()).toContain('barbell')
  })

  it('is stable between calls, so the prompt does not churn', () => {
    const p = profile({ place: 'home_basic' })
    expect(catalogDigest(p)).toEqual(catalogDigest(p))
  })
})
