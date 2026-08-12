// A no-equipment, 3-day-a-week beginner plan.
//
// Why this shape:
//  * Three FULL-BODY days, not a split. At three sessions a week a push/pull/legs split hits each
//    muscle once every seven days, which is under the dose a beginner grows and gets stronger on.
//    Full-body three times means every movement pattern gets trained three times a week.
//  * Every exercise is `eq: 'body weight'` AND needs nothing but a floor, a wall and a towel.
//    Deliberately excluded even though the dataset calls them bodyweight: pull-ups and inverted
//    rows (need a bar), bench dips and hyperextensions (need a bench), incline push-ups (need a
//    box). The towel rows are the only way to load a pull without a bar.
//  * Pushing starts on the knees and against the wall. A beginner who cannot do one clean full
//    push-up learns nothing from three sets of failing at it, and the progression below walks the
//    reps up on its own.
//  * Each day ends with a timed core hold or a timed conditioning block — that is the fat-loss
//    half of the goal, and timed work progresses by seconds instead of by weight there is none of.
//
// Progression, which the app does by itself: bodyweight entries carry no load, so progression.js
// takes the reps branch — every rep clean means +1 rep next session, and on hitting `repsMax` the
// reps drop back to the bottom and a set is added instead (up to MAX_BW_SETS). That is why every
// reps entry here has a repsMax: without one the target grows forever and a set of 40 squats stops
// being strength work. Timed entries get prog: 'time', which adds seconds the same way.
//
// Unilateral entries carry `side: true` and an EVEN total rep count — the app stores the total
// across both sides and derives "8 per side" for display, and an odd total would put a rep on one
// leg and not the other.

import { uid } from './format.js'
import { t } from './i18n-core.js'

const REPS = (id, sets, reps, repsMax, side) => ({
  id, sets, reps, repsMax, weight: 0, mode: 'reps', bodyweight: true, prog: 'linear',
  ...(side ? { side: true } : {})
})
const TIME = (id, sets, sec) => ({
  id, sets, sec, weight: 0, mode: 'time', bodyweight: true, prog: 'time'
})

// name key, icon, day of week (0 = Sunday, 6 = Saturday), exercises
const SPEC = [
  ['Home Day A — Full body', 'figureStrength', 6, [
    REPS('3533', 3, 12, 20),        // bodyweight squat
    REPS('3211', 3, 8, 15),         // kneeling push-up
    REPS('3165', 3, 12, 20),        // standing row with a towel
    REPS('3013', 3, 14, 22),        // low glute bridge on floor
    TIME('3665', 3, 30),            // power point plank
    TIME('3636', 3, 40)             // high knees against a wall
  ]],
  ['Home Day B — Full body', 'legs', 1, [
    REPS('3470', 3, 16, 24, true),  // forward lunge, 8 per side
    REPS('0659', 3, 10, 18),        // wall push-up
    REPS('3161', 3, 16, 24, true),  // one-arm towel row, 8 per side
    REPS('0668', 3, 14, 22),        // rear decline bridge
    REPS('0872', 3, 10, 18),        // reverse crunch
    REPS('1373', 3, 15, 25)         // standing calf raise
  ]],
  ['Home Day C — Full body', 'flame', 3, [
    REPS('2368', 3, 16, 24, true),  // split squat, 8 per side
    REPS('3211', 3, 10, 18),        // kneeling push-up
    REPS('3165', 3, 14, 22),        // standing row with a towel
    REPS('1352', 3, 12, 20),        // prone back extension
    REPS('0276', 3, 16, 24, true),  // dead bug, 8 per side
    TIME('0630', 3, 30)             // mountain climber
  ]]
]

/** The three routines, with fresh ids. Order matches SPEC: [A, B, C]. */
export const homeRoutines = () =>
  SPEC.map(([name, emoji, , ex]) => ({
    id: uid(),
    name: t(name),
    emoji,
    ex: ex.map(e => ({ ...e }))
  }))

/** Which day of the week each routine goes on, in the same order as homeRoutines(). */
export const HOME_DAYS = SPEC.map(([, , day]) => day)
