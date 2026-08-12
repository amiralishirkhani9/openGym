import { EXDB } from './exercises-data.js'
import { t } from './i18n-core.js'

export { EXDB }

// The generated dataset already supplies secondary muscles for most exercises. Keep the
// handful of conservative catalogue additions that are useful to the muscle map here so a
// dataset refresh does not erase them. Values follow the dataset's existing alias vocabulary.
const SECONDARY_ADDITIONS = {
  '0027': ['rear deltoids'], // barbell bent over row
  '0293': ['rear deltoids'], // dumbbell bent over row
  '0499': ['rear deltoids'], // inverted row
  '0861': ['rear deltoids'], // cable seated row
}

// A few upstream entries are labelled with a muscle instead of a movement — id 3533's
// instructions describe a bodyweight squat but its name is literally "quads", which renders as a
// body part in every list, in the routine editor and mid-workout. Renaming here (rather than
// editing the generated dataset) survives a dataset refresh, same as SECONDARY_ADDITIONS.
const NAME_FIXES = {
  '3533': 'bodyweight squat',
  '3013': 'glute bridge',
  '1352': 'back extension on floor',
  '3636': 'high knees (wall support)',
}

export const EXIDX = {}
EXDB.forEach(e => {
  const additions = SECONDARY_ADDITIONS[e.id]
  if (additions) e.sm = [...new Set([...(e.sm || []), ...additions])]
  if (NAME_FIXES[e.id]) e.n = NAME_FIXES[e.id]
  EXIDX[e.id] = e
})
export const BODYPARTS = [...new Set(EXDB.map(e => e.bp))].sort()

// Equipment options present in a given list of exercises, most common first (issue #6).
// Deriving them from the *already filtered* list keeps the chip row short and means
// every body-part × equipment combination on screen has results behind it.
export function equipmentOf(list) {
  const c = {}
  list.forEach(e => { if (e.eq) c[e.eq] = (c[e.eq] || 0) + 1 })
  return Object.keys(c).sort((a, b) => c[b] - c[a] || (a < b ? -1 : 1))
}

// Custom (user-created) exercises live in synced state S.customEx (issue #11) and are
// merged into the id index here so every EXIDX[id] lookup keeps working unchanged.
let customIds = []
export function registerCustom(list) {
  customIds.forEach(id => delete EXIDX[id])
  customIds = (list || []).map(e => e.id)
  ;(list || []).forEach(e => { EXIDX[e.id] = e })
}
// Full searchable catalogue — customs first so your own exercises are easy to find.
export const allExercises = st => [...(st.customEx || []), ...EXDB]

// Media normally sits next to the app (img/ and gif/, mounted into the web container).
// A build can point them somewhere else — the demo build pulls them off a CDN instead of
// shipping ~140 MB of images into the deployment. `import.meta.env` is undefined in plain
// Node; the guard keeps this module loadable without Vite.
const ENV = import.meta.env || {}
const IMG_BASE = ENV.VITE_IMG_BASE || 'img/'
const GIF_BASE = ENV.VITE_GIF_BASE || 'gif/'
// The dataset names .gif/.jpg, so extensions are swapped here rather than in 1324
// dataset entries that a refresh would overwrite. The stems are identical, so an
// override (VITE_IMG_BASE) pointing at the original files still resolves.
//
// Stills are WebP. Animations are H.264 in MP4, not animated WebP: the clips are
// 4-12 frames of a nearly static figure, which inter-frame prediction handles
// far better than a format that pays close to full price per frame. Measured over
// a sample of the set, at 540x540: animated WebP q75 came to ~115 MB across the
// 1324 exercises, H.264 crf20 to ~57 MB. That is what pays for tripling the
// resolution without growing the download.
const swap = (name, ext) => name.replace(/\.(gif|jpg|jpeg|png|mp4|webp)$/i, ext)
export const imgSrc = ex => IMG_BASE + swap(ex.img, '.webp')
export const gifSrc = ex => GIF_BASE + swap(ex.gif, '.mp4')

// Cardio exercises log time + speed instead of weight × reps.
export const isCardio = idOrEx => (typeof idOrEx === 'string' ? EXIDX[idOrEx] : idOrEx)?.bp === 'cardio'

// Exercises the dataset already knows carry no external load (issue #32) — a quarter of the
// catalogue. This seeds the `bw` flag on a fresh config so a push-up never asks for a weight
// nobody was going to enter. It is only the default: the flag lives on the config, so a dip
// done with a belt can turn it off and a custom exercise can turn it on.
export const isBodyweightEq = idOrEx =>
  (typeof idOrEx === 'string' ? EXIDX[idOrEx] : idOrEx)?.eq === 'body weight'

// An id that resolves to nothing — a plan file built against a different exercise dataset,
// a custom exercise deleted on another device before the sync arrived — still has to
// render. A placeholder keeps it visible (and removable) instead of taking the whole view
// down on the first `ex.n`.
export const exOr = id => EXIDX[id] ||
  { id, n: t('Unknown exercise'), bp: '', tg: '', eq: '', sm: [], st: [], missing: true }
