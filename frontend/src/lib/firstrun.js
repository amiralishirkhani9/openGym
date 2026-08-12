// What a fresh install starts with.
//
// Deliberately almost nothing. Earlier versions seeded a canned no-equipment plan so the first
// screen had something to start, but a prescription nobody asked for is worse than an empty week:
// it has to be deleted before it can be replaced, and it quietly sets expectations about what the
// app thinks you should be doing. The plan is now yours to build, or the coach's to write.
//
// Strictly first-run only: the caller gates on there being no routines, no workouts and no
// weigh-ins, so updating over an existing install never touches anything.
//
// Build-time options, both off by default:
//   VITE_SEED_LANG — start in this language instead of the store default
//   VITE_SEED_BW   — record this as the first weigh-in, so the chart and goal have an anchor

import { todayISO } from './format.js'
import { setLang } from './i18n.js'

const ENV = import.meta.env || {}
const SEED_LANG = ENV.VITE_SEED_LANG || ''
const SEED_BW = Number(ENV.VITE_SEED_BW) || 0

/**
 * Mutates a fresh state in place. Options override the build-time defaults (used by tests).
 *
 * Still async: setLang loads a locale pack, and callers await this before first paint.
 *
 * No routines are created. S.coach is left null on purpose — the coach asks its questions
 * rather than inheriting assumptions from a plan that no longer exists.
 */
export async function seedFirstRun(S, { bodyweight = SEED_BW, lang = SEED_LANG } = {}) {
  if (lang) {
    S.lang = lang
    await setLang(lang)
  }
  if (bodyweight > 0 && !S.bodyweight.length) {
    S.bodyweight.push({ d: todayISO(), w: bodyweight, t: Date.now() })
  }
  return S
}
