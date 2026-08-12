// The training profile the AI coach builds a plan from.
//
// The coach could already be asked for a plan in prose, and that is the problem: a good plan needs
// six or seven specific facts (experience, days available, equipment, goal, session length,
// injuries), and typing them into a chat box every time means most of them get left out. The model
// then invents them — a barbell programme for someone with an empty living room.
//
// So the facts are a form, stored once and reused. It lives in S (not localStorage like the API
// key) because it is not a secret, it belongs in a backup, and the self-hosted build should carry
// it between devices.

export const LEVELS = ['beginner', 'returning', 'intermediate', 'advanced']

// What the user has to train with, in the dataset's own equipment vocabulary. `eq` values here
// are matched against exercise.eq exactly, which is what makes the catalogue digest — and so the
// model's choices — actually restricted to their kit.
export const PLACES = {
  home_none: {
    label: 'Home — no equipment',
    eq: ['body weight', 'assisted'],
  },
  home_basic: {
    label: 'Home — dumbbells / bands',
    eq: ['body weight', 'assisted', 'dumbbell', 'band', 'resistance band', 'kettlebell',
      'stability ball', 'medicine ball', 'roller', 'wheel roller', 'bosu ball', 'weighted'],
  },
  gym_full: {
    label: 'Full gym',
    eq: null,   // null = no restriction
  },
}

export const GOALS = ['fat_loss', 'strength', 'muscle', 'endurance', 'general']

// Body areas someone can flag as a problem. Mapped to dataset target/secondary muscle names so a
// flagged area can be turned into an explicit exclusion list for the model.
export const LIMITS = {
  lower_back: { label: 'Lower back', muscles: ['spine'] },
  knee: { label: 'Knees', muscles: ['quads', 'hamstrings'] },
  shoulder: { label: 'Shoulders', muscles: ['delts', 'serratus anterior', 'levator scapulae'] },
  wrist: { label: 'Wrists / elbows', muscles: ['forearms'] },
  neck: { label: 'Neck', muscles: ['traps', 'levator scapulae'] },
  hip: { label: 'Hips', muscles: ['glutes', 'adductors', 'abductors'] },
}

export const DEF_PROFILE = {
  level: 'beginner',
  days: [6, 1, 3],          // days of the week, 0 = Sunday
  place: 'home_none',
  goals: ['fat_loss', 'strength'],
  sessionMin: 45,
  limits: [],
  notes: '',
}

export const getProfile = S => ({ ...DEF_PROFILE, ...(S.coach || {}) })
export const hasProfile = S => !!(S.coach && S.coach._set)

/** Equipment whitelist for a profile, or null for "everything". */
export const equipmentFor = profile => (PLACES[profile.place] || PLACES.home_none).eq

/** Muscles to avoid loading, derived from the flagged problem areas. */
export function avoidMuscles(profile) {
  const out = new Set()
  for (const k of profile.limits || []) {
    for (const m of (LIMITS[k] || {}).muscles || []) out.add(m)
  }
  return [...out]
}

// Sets per session that fits the time budget: roughly 3 working sets a movement, ~2.5 min a set
// once rest is counted, plus a few minutes to warm up. Used to tell the model how many exercises
// it may prescribe, because "45 minutes" alone reliably produces a 12-exercise session.
export function exercisesForTime(min) {
  const usable = Math.max(15, Math.min(150, Number(min) || 45)) - 6
  return Math.max(3, Math.min(10, Math.round(usable / 7.5)))
}
