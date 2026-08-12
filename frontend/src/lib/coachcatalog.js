// The exercise catalogue, condensed into something a model can be given in a prompt.
//
// Why this exists: the coach used to be told "use real exercise names, they are matched against a
// 1300-exercise library" and nothing more. That is a request to guess. It guessed names the
// library does not have (they silently dropped out of the plan), and it guessed equipment the user
// does not own — the single most common way a generated plan turns out to be undoable.
//
// So the model is handed an actual list, filtered to the user's equipment. The full catalogue is
// ~9.5k tokens of names, which is affordable but wasteful, and most of it is near-duplicates
// ("jump squat" / "jump squat v. 2" / "squat to overhead reach with twist"). PER_TARGET picks a
// spread instead: the plainest, most recognisable movements per muscle, which is what a programme
// is built from anyway.

import { EXDB } from './exercises.js'
import { equipmentFor, avoidMuscles } from './coachprofile.js'

const PER_TARGET = 18

// Exercises whose NAME implies kit that `eq` does not mention. The dataset labels pull-ups, dips
// and inverted rows "body weight", which is true and useless: someone with an empty room cannot do
// them, and they are exactly what a model reaches for when asked for a bodyweight back workout.
// Same exclusion homeplan.js applies by hand, generalised.
//
// Split by what is actually missing, because the two groups fail differently — one needs a thing
// to hang from, the other needs a thing to put your feet on.
const NEEDS_ANCHOR = new RegExp([
  'bar\\b', 'barbell', 'pull[ -]?ups?\\b', 'chin[ -]?ups?\\b', 'chin\\b', 'muscle ?up',
  'inverted row', 'lever\\b', 'skin the cat', 'hang', 'scapula(r)? (dip|pull)', 'elevator',
  'standing archer', 'archer pull', 'elbow lift', 'towel row',   // towel rows need a door or post
  'parallel bars', 'rings?\\b', 'strap', 'suspend', 'suspension', 'wall bars',
].join('|'), 'i')

const NEEDS_SURFACE = new RegExp([
  'bench', 'box\\b', 'cage', 'rack', 'dips?\\b', 'step[ -]?ups?\\b', 'staircase', 'stairs',
  'incline', 'decline', 'platform', 'chair', 'depth jump', 'seated side crunch',
].join('|'), 'i')

const NEEDS_APPARATUS = new RegExp([
  'machine', 'ball\\b', 'band\\b', 'rope\\b', 'sled', 'wheel', 'roller', 'tire', 'ergometer',
  'treadmill', 'bike', 'elliptical', 'stepmill', 'skierg', 'board\\b', 'slide\\b', 'equipment',
].join('|'), 'i')

// Gymnastics skills the dataset lists next to push-ups because they are also unweighted. A planche
// is not a prescription — it is a multi-year project — and their short plain names score well on
// `rank`, so without this they outrank actual exercises and land in a beginner's plan.
const ELITE = new RegExp([
  'planche', 'maltese', 'flag\\b', 'handstand', 'l-?sit', 'v-?sit', 'stalder', 'front lever',
  'back lever', 'one arm (push|chin|pull)', 'single arm push-?up', 'pistol', 'sissy squat',
  'impossible', 'korean', 'gironda', 'kipping',
].join('|'), 'i')

// Junk for prompt purposes: numbered variants crowd out the movement someone actually needs, and
// stretches are not training — a model asked for a bodyweight leg day will otherwise fill the
// session with them whenever the real options run thin.
const VARIANT = /\bv\.?\s*\d|\bversion\s*\d|\bvariation\b/i
const NOT_TRAINING = /\bstretch(es|ing)?\b|\bmobility\b|\bmassage\b|\byoga\b|\bcircles\b|\bpose\b|boxing/i

// Lower is better. The aim is the canonical version of a movement: no gendered duplicate, no
// numbered variant, short plain name.
function rank(e) {
  let s = e.n.length
  if (/\((male|female)\)/i.test(e.n)) s += 30
  if (VARIANT.test(e.n)) s += 60
  if (e.n.split(' ').length > 5) s += 20
  return s
}

/**
 * Exercises available to a profile: equipment filtered, and for the no-equipment case also
 * filtered on names that imply kit.
 */
export function poolFor(profile, all = EXDB) {
  const eq = equipmentFor(profile)
  let pool = eq ? all.filter(e => eq.includes(e.eq)) : all.slice()
  if (profile.place === 'home_none') {
    pool = pool.filter(e => !NEEDS_ANCHOR.test(e.n) && !NEEDS_SURFACE.test(e.n) && !NEEDS_APPARATUS.test(e.n))
  }
  const avoid = avoidMuscles(profile)
  if (avoid.length) {
    // Only the primary target is excluded. Dropping everything that lists a bad joint as a
    // secondary muscle empties the catalogue — almost every lower-body movement mentions the
    // knees somewhere.
    pool = pool.filter(e => !avoid.includes(e.tg))
  }
  return pool.filter(e => !NOT_TRAINING.test(e.n) && !ELITE.test(e.n))
}

/**
 * A compact "target: name, name, …" digest of the pool, capped per muscle.
 * This is what goes into the system prompt.
 */
export function catalogDigest(profile, all = EXDB) {
  const pool = poolFor(profile, all)
  const byTarget = {}
  for (const e of pool) (byTarget[e.tg] ||= []).push(e)
  const lines = []
  for (const [tg, list] of Object.entries(byTarget)) {
    if (!tg) continue
    const seen = new Set()
    const picked = []
    // The dataset has genuine duplicate names (three "self assisted inverse leg curl" entries).
    // Two identical names in a prompt is a wasted slot and an ambiguous instruction.
    for (const e of list.slice().sort((a, b) => rank(a) - rank(b))) {
      const k = e.n.toLowerCase()
      if (seen.has(k)) continue
      seen.add(k)
      picked.push(e)
      if (picked.length >= PER_TARGET) break
    }
    // Alphabetical inside a line reads as a list rather than a ranking, and keeps the digest
    // stable between builds so a cached prompt does not churn.
    picked.sort((a, b) => a.n.localeCompare(b.n))
    lines.push(`${tg}: ${picked.map(e => e.n).join(', ')}`)
  }
  lines.sort()
  return lines.join('\n')
}
