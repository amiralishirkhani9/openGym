// What a fresh install starts with.
//
// The plan used to arrive only when you found the "Load starter plan" button, which meant a first
// launch showed an empty week and a Rest day for every day — nothing to press Start on. This seeds
// the no-equipment plan (lib/homeplan.js) so the app is usable from the first screen, without
// assuming a gym, a barbell or a rack.
//
// Strictly first-run only: the caller gates on there being no routines, no workouts and no
// weigh-ins, so updating over an existing install never touches a plan someone has been using.
//
// The two personal bits are build-time and default to off, so a plain build seeds the plan and
// nothing else:
//   VITE_SEED_LANG — start in this language instead of English
//   VITE_SEED_BW   — record this as the first weigh-in, so the chart and goal have an anchor

import { homeRoutines, HOME_DAYS } from './homeplan.js'
import { todayISO } from './format.js'
import { setLang } from './i18n.js'
import { DEF_PROFILE } from './coachprofile.js'

const ENV = import.meta.env || {}
const SEED_LANG = ENV.VITE_SEED_LANG || ''
const SEED_BW = Number(ENV.VITE_SEED_BW) || 0

/**
 * Mutates a fresh state in place. Options override the build-time defaults (used by tests).
 *
 * Async because of the language: routine names are stored strings, translated once by
 * homeRoutines() at the moment they are created. App.jsx does not call setLang until after boot
 * resolves, so seeding first would bake the English names into the plan permanently and no later
 * language switch would fix them. Loading the pack here is what makes the seeded plan land in the
 * user's language.
 */
export async function seedFirstRun(S, { bodyweight = SEED_BW, lang = SEED_LANG } = {}) {
  if (lang) {
    S.lang = lang
    await setLang(lang)
  }
  const rs = homeRoutines()
  S.routines.push(...rs)
  HOME_DAYS.forEach((d, i) => { S.week[d] = rs[i].id })

  // The coach profile is seeded to describe the plan that was just seeded: same days, no
  // equipment, beginner. Without this the AI coach's first act is to ask the six questions the
  // seeded plan already answers, and until it is told otherwise it treats "no equipment" as a
  // guess it may override — which is how a barbell programme lands on someone's floor.
  // Marked _set so the coach can revise the plan straight away; the form is still there to change
  // any of it.
  S.coach = { ...DEF_PROFILE, days: [...HOME_DAYS] }
  S.coach._set = true
  if (bodyweight > 0 && !S.bodyweight.length) {
    S.bodyweight.push({ d: todayISO(), w: bodyweight, t: Date.now() })
  }
  return S
}
