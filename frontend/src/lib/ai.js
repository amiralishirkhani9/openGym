// AI coach transport + plan actions.
//
// Two reasons this is its own module rather than inline in the view:
//
// 1. HTTP. In the native build the WebView origin is http://localhost, so a request to any
//    API host is cross-origin and dies on CORS preflight — providers do not send back an
//    Access-Control-Allow-Origin for an app. On mobile we therefore go through CapacitorHttp,
//    which performs the request in Java. We call the plugin DIRECTLY rather than enabling its
//    fetch patch: the patch hands back an object that only looks like a Response, and calling
//    .json() on it parses an already-parsed body — the source of
//    "Unexpected non-whitespace character after JSON at position N".
// 2. Plan writing. Turning a model's JSON into real routines needs the exercise index and the
//    same config shape defaultConfig() produces, and it should be testable without a WebView.

import { EXDB, EXIDX, allExercises } from './exercises.js'
import { defaultConfig, modeOf, isPerSide, effortOf, EFFORT } from './history.js'
import { uid, todayISO } from './format.js'
import { GLYPHS } from './glyphs.js'
import { MOBILE } from './mobile.js'
import { POLICIES_FOR, MAX_BW_SETS, policyFor, sessionsFor, POLICY_NAME } from './progression.js'
import { getProfile, hasProfile, PLACES, LIMITS, exercisesForTime } from './coachprofile.js'
import { catalogDigest } from './coachcatalog.js'
import { fatigueOf, strengthOf } from './recovery.js'
import { MUSCLES, MUSCLE_NAME, loadOfWorkouts } from './muscles.js'

// ─────────────────────────────────────────────────────────── transport ──

// Accepts whatever the user pasted (bare host, .../v1, a full completions URL) and returns
// origin+prefix without a trailing /v1, so callers append the path they want.
export function apiRoot(raw) {
  let u = (raw || '').trim().replace(/\s+/g, '')
  if (!u) return ''
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u
  u = u.replace(/\/+$/, '')
  u = u.replace(/\/(chat\/completions|completions|models)$/i, '')
  u = u.replace(/\/v1$/i, '')
  return u
}
export const chatUrl = raw => apiRoot(raw) + '/v1/chat/completions'
export const modelsUrl = raw => apiRoot(raw) + '/v1/models'
export const messagesUrl = raw => apiRoot(raw) + '/v1/messages'

// Anthropic is not OpenAI-shaped: different path, different auth header, `system` hoisted out
// of messages[], and the reply arrives as an array of content blocks. Everything else people
// plug in here (OpenAI, OpenRouter, Groq, Ollama, LM Studio) speaks the OpenAI shape, so the
// wire format is derived from the host instead of asking the user a second question.
export function wireFor(base) {
  return /(^|\.)anthropic\.com$/i.test(hostOf(base)) ? 'anthropic' : 'openai'
}

function hostOf(base) {
  try { return new URL(apiRoot(base) || 'https://x').hostname } catch { return '' }
}

const safeParse = s => { try { return JSON.parse(s) } catch { return null } }
const errText = d => (d && (d.error?.message || (typeof d.error === 'string' ? d.error : '') || d.message)) || ''

// One request helper for both builds. Returns the parsed JSON body, or throws an Error whose
// message is the provider's own text where there is one — "HTTP 401" alone is useless when the
// real answer is "this key has no credit".
export async function apiJSON({ url, method = 'GET', key, body, signal, wire = 'openai' }) {
  const headers = { Accept: 'application/json' }
  if (key && wire === 'anthropic') {
    headers['x-api-key'] = key
    headers['anthropic-version'] = '2023-06-01'
    // The browser build calls from a page origin, which Anthropic rejects unless the caller
    // opts in explicitly. The native build goes through Java and is unaffected.
    headers['anthropic-dangerous-direct-browser-access'] = 'true'
  } else if (key) {
    headers.Authorization = 'Bearer ' + key
  }
  if (body) headers['Content-Type'] = 'application/json'

  if (MOBILE) {
    const { CapacitorHttp } = await import('@capacitor/core')
    const res = await CapacitorHttp.request({
      url, method, headers,
      // The plugin serialises a plain object itself; a pre-stringified body double-encodes.
      ...(body ? { data: body } : {}),
      readTimeout: 120000, connectTimeout: 30000,
    })
    const data = typeof res.data === 'string' ? safeParse(res.data) : res.data
    if (res.status < 200 || res.status >= 300) throw new Error(errText(data) || 'HTTP ' + res.status)
    if (data == null) throw new Error('Malformed response')
    return data
  }

  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, signal })
  const text = await res.text()
  const data = safeParse(text)
  if (!res.ok) throw new Error(errText(data) || 'HTTP ' + res.status)
  if (data == null) throw new Error('Malformed response')
  return data
}

// ─────────────────────────────────────────────────────────── models ──

const PROVIDER = {
  openai: 'OpenAI', anthropic: 'Anthropic', google: 'Google', gemini: 'Google',
  meta: 'Meta', 'meta-llama': 'Meta', mistralai: 'Mistral', qwen: 'Alibaba',
  deepseek: 'DeepSeek', xai: 'xAI', groq: 'Groq', cohere: 'Cohere',
  nvidia: 'NVIDIA', microsoft: 'Microsoft', openrouter: 'OpenRouter',
  cerebras: 'Cerebras', perplexity: 'Perplexity', moonshotai: 'Moonshot',
}

export async function listModels(base, key) {
  const wire = wireFor(base)
  // Anthropic's /v1/models needs the same auth headers as a chat call.
  const data = await apiJSON({ url: modelsUrl(base), key, wire })
  const raw = data.data || data.models || (Array.isArray(data) ? data : [])
  const list = raw.map(m => {
    const id = typeof m === 'string' ? m : (m.id || m.name || '')
    if (!id) return null
    const vendor = id.includes('/') ? id.split('/')[0] : ''
    const owner = (typeof m === 'object' && m.owned_by) || ''
    const provider = wire === 'anthropic' ? 'Anthropic'
      : PROVIDER[vendor.toLowerCase()] || PROVIDER[owner.toLowerCase()] || vendor || owner || ''
    return { id, name: id.split('/').pop(), provider }
  }).filter(Boolean)
  list.sort((a, b) => (a.provider || '~').localeCompare(b.provider || '~') || a.name.localeCompare(b.name))
  return list
}

// ─────────────────────────────────────────────────────── chat completion ──

// Anthropic requires no system turns inside messages[], a non-empty list, a first turn with
// role "user", and no two consecutive turns with the same role — so they get merged.
export function splitSystem(messages) {
  const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n')
  const turns = []
  for (const m of messages) {
    if (m.role === 'system') continue
    const role = m.role === 'assistant' ? 'assistant' : 'user'
    const content = String(m.content ?? '')
    const last = turns[turns.length - 1]
    if (last && last.role === role) last.content += '\n\n' + content
    else turns.push({ role, content })
  }
  if (!turns.length) turns.push({ role: 'user', content: '...' })
  if (turns[0].role !== 'user') turns.unshift({ role: 'user', content: '...' })
  return { system, messages: turns }
}

// The one entry point every caller uses, so adding a provider never means touching a view.
// Returns the assistant's text, or throws with the provider's own error message.
export async function chatComplete({ base, key, model, messages, temperature = 0.7, maxTokens = 2000, signal }) {
  if (wireFor(base) === 'anthropic') {
    const { system, messages: turns } = splitSystem(messages)
    const data = await apiJSON({
      url: messagesUrl(base), method: 'POST', key, signal, wire: 'anthropic',
      body: { model, max_tokens: maxTokens, temperature, ...(system ? { system } : {}), messages: turns },
    })
    const blocks = Array.isArray(data.content) ? data.content : []
    return blocks.filter(b => b?.type === 'text').map(b => b.text).join('').trim()
  }
  const data = await apiJSON({
    url: chatUrl(base), method: 'POST', key, signal,
    body: { model, messages, temperature, max_tokens: maxTokens },
  })
  return data.choices?.[0]?.message?.content || ''
}

// ─────────────────────────────────────────────────────────── prompt ──

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

const GOAL_TEXT = {
  fat_loss: 'lose fat',
  strength: 'get stronger',
  muscle: 'build muscle',
  endurance: 'build conditioning / endurance',
  general: 'general fitness',
}
const LEVEL_TEXT = {
  beginner: 'a complete beginner — has not trained before',
  returning: 'returning after a long break',
  intermediate: 'has trained consistently for a year or more',
  advanced: 'advanced, several years of consistent training',
}

// The training profile in prose. This is the block that replaces asking the user the same six
// questions in the chat box every time — see lib/coachprofile.js.
function profileBlock(S) {
  const p = getProfile(S)
  const days = (p.days || []).map(d => DAY_NAMES[d]).join(', ') || '(not set)'
  const limits = (p.limits || []).map(k => (LIMITS[k] || {}).label || k)
  const maxEx = exercisesForTime(p.sessionMin)
  return `TRAINING PROFILE${hasProfile(S) ? '' : ' (defaults — the user has not filled this in yet)'}
experience: ${LEVEL_TEXT[p.level] || p.level}
trains on: ${days} (${(p.days || []).length} days a week)
equipment: ${(PLACES[p.place] || {}).label || p.place}
goals: ${(p.goals || []).map(g => GOAL_TEXT[g] || g).join(' + ') || 'general fitness'}
session length: ${p.sessionMin} minutes — so at most ${maxEx} exercises per day
injuries / avoid: ${limits.length ? limits.join(', ') : 'none'}${p.notes ? `
extra notes from the user: ${p.notes}` : ''}`
}

// Per-muscle recovery, from the same functions the Stats screen draws.
//
// Without this the coach could see WHAT is planned but not what the body had actually
// absorbed, so "what should I train today" was answered from the weekly plan alone. The
// thresholds match lib/recovery.js: fatigue above 0.5 is fatigued, 0.25-0.5 recovering.
// Retained strength below 1 means the muscle is past its full-retention window.
function recoveryBlock(S, now) {
  const workouts = S.workouts || []
  if (!workouts.length) return 'RECOVERY\nNo logged workouts yet, so nothing is fatigued and nothing is known about retention.'

  const fatigue = fatigueOf(workouts, now)
  const strength = strengthOf(workouts, now)
  const name = slug => MUSCLE_NAME[slug] || slug

  const fatigued = MUSCLES.filter(m => fatigue[m] > 0.5)
  const recovering = MUSCLES.filter(m => fatigue[m] > 0.25 && fatigue[m] <= 0.5)
  // 0.99 rather than 1: strengthOf returns exactly 1 inside the full-retention window, and
  // floating point on the decay path lands a hair under it for a muscle trained seconds ago.
  const detrained = MUSCLES.filter(m => strength[m] < 0.99)

  // Sets per muscle over the last 30 days -- the balance question, in the unit the app
  // counts in (completed working sets, weighted by how much each muscle contributes).
  const cutoff = new Date(now - 30 * 24 * 3600 * 1000).toISOString().slice(0, 10)
  const load = loadOfWorkouts(workouts.filter(w => (w.d || '') >= cutoff))
  const worked = MUSCLES.filter(m => (load[m] || 0) > 0).sort((a, b) => load[b] - load[a])
  const untouched = MUSCLES.filter(m => !(load[m] > 0))

  return `RECOVERY (from the log, not from the plan)
fatigued right now (avoid loading): ${fatigued.length ? fatigued.map(name).join(', ') : 'none'}
still recovering: ${recovering.length ? recovering.map(name).join(', ') : 'none'}
losing retention (trained too long ago): ${detrained.length ? detrained.map(name).join(', ') : 'none'}
sets per muscle, last 30 days: ${worked.length ? worked.map(m => `${name(m)} ${Math.round(load[m] * 10) / 10}`).join(', ') : 'none'}
no sets at all in 30 days: ${untouched.length ? untouched.map(name).join(', ') : 'none'}`
}

// What the app's own progression engine is already doing, per exercise in the plan.
//
// The coach used to suggest "add 2.5kg to your squat" for an exercise the app was going to
// add 2.5kg to by itself on the next clean session -- because it could not see that a
// policy existed. This tells it the policy and whether the last session hit its target.
function progressionBlock(S) {
  const lines = []
  for (const r of S.routines || []) {
    for (const cfg of r.ex || []) {
      const ex = EXIDX[cfg.id]
      if (!ex) continue
      const policy = policyFor(cfg, r, modeOf(cfg))
      if (policy === 'off') continue
      const sessions = sessionsFor(S, cfg.id, cfg)
      const last = sessions[sessions.length - 1]
      const state = !last ? 'nothing logged yet'
        : last.ok ? 'last session hit the target, so it goes up next time'
          : 'last session missed the target'
      lines.push(`- ${ex.n} in "${r.name}": ${POLICY_NAME[policy] || policy} — ${state}`)
    }
  }
  if (!lines.length) return ''
  return `\nAUTOMATIC PROGRESSION ALREADY RUNNING
The app raises these by itself. Do not tell the user to add weight or reps here — it is handled.
${lines.slice(0, 40).join('\n')}`
}

// The model is told what the user actually has, in the app's own vocabulary, so "add a row to
// pull day" resolves against real routine names instead of being answered in the abstract.
//
// `now` is injected so the recovery block is deterministic under test.
export function buildSystemPrompt(S, lang, now = Date.now()) {
  const unit = S.unit || 'kg'
  const routines = S.routines || []
  const profile = getProfile(S)
  const routineLines = routines.length
    ? routines.map(r => {
      const ex = (r.ex || []).map(e => {
        const name = (EXIDX[e.id] || {}).n || e.id
        const m = modeOf(e)
        if (m === 'cardio') return `${name} ${e.min || 20}min`
        if (m === 'time') return `${name} ${e.sets}x${e.sec}s`
        const side = isPerSide(e) ? '/side' : ''
        const cap = e.repsMax ? `-${e.repsMax}` : ''
        return `${name} ${e.sets}x${e.reps}${cap}${side}${e.weight ? ` @ ${e.weight}${unit}` : ''}`
      })
      return `- "${r.name}": ${ex.length ? ex.join('; ') : '(empty)'}`
    }).join('\n')
    : '(none yet)'

  const week = [1, 2, 3, 4, 5, 6, 0].map(d => {
    const r = routines.find(x => x.id === (S.week || {})[d])
    return `${DAY_NAMES[d]}=${r ? r.name : 'rest'}`
  }).join(', ')

  const bw = (S.bodyweight || []).slice(-8)
  const bwLine = bw.length ? bw.map(b => `${b.d} ${b.w}${unit}`).join(', ') : '(none)'
  const goal = S.targetW ? `${S.targetW}${unit}` : '(none)'
  const recent = (S.workouts || []).slice(-8).map(w => {
    const r = routines.find(x => x.id === w.rid)
    const sets = (w.ex || []).reduce((n, e) => n + (e.sets || []).filter(s => s.done).length, 0)
    return `${w.d} ${r ? r.name : (w.name || 'freestyle')} (${sets} sets)`
  }).join('; ') || '(none)'

  const langLine = lang === 'fa' ? 'Persian (فارسی)' : (lang || 'the user\'s language')

  return `You are the AI coach built into openGym, a workout tracker. You are not a generic
assistant: you can read the user's data below and you can WRITE to their plan by emitting an
action block. Never claim you lack access to the app — you have it.

${profileBlock(S)}

USER DATA
unit: ${unit}
body weight goal: ${goal}
recent weigh-ins: ${bwLine}
week: ${week}
routines:
${routineLines}
recent workouts: ${recent}

SETTINGS you can change (current values)
rest timer: ${S.restSec || 90}s
effort scale logged per set: ${effortOf(S)}
sounds: ${S.sound ? 'on' : 'off'}
keep screen awake during a workout: ${S.keepAwake === false ? 'off' : 'on'}

${recoveryBlock(S, now)}
${progressionBlock(S)}

EXERCISE LIBRARY
These are the exercises available for this user's equipment. USE THESE NAMES EXACTLY. A name that
is not in this list is matched by similarity and may resolve to something else or be dropped.
${catalogDigest(profile)}

WRITING TO THE PLAN
To change the plan, end your reply with ONE fenced block tagged opengym containing JSON.

Create routines, optionally scheduling them:
\`\`\`opengym
{"action":"create_plan","routines":[{"name":"Full body A","glyph":"figureStrength","exercises":[{"name":"bodyweight squat","sets":3,"reps":12,"repsMax":20},{"name":"push-up (wall)","sets":3,"reps":10,"repsMax":18}]}],"week":{"6":"Full body A"}}
\`\`\`
week keys: 0=Sunday .. 6=Saturday; values are routine names.
glyph: ${GLYPHS.join(' ')}
Reusing a name that already exists rewrites that routine instead of making a second copy, so
rebuilding the plan keeps the user's history on those days.

Change a routine that already exists — omit a field to leave it alone. "exercises" REPLACES the
whole list, so include everything you want the day to end up with:
\`\`\`opengym
{"action":"update_routine","routine":"Full body A","name":"Full body A","glyph":"legs","exercises":[{"name":"split squats","sets":3,"reps":16,"side":true}]}
\`\`\`

Append to a routine:
\`\`\`opengym
{"action":"add_exercises","routine":"Full body A","exercises":[{"name":"dead bug","sets":3,"reps":16,"side":true}]}
\`\`\`

Remove exercises from a routine:
\`\`\`opengym
{"action":"remove_exercises","routine":"Full body A","exercises":["sissy squat"]}
\`\`\`

Schedule existing routines only (or delete a routine):
\`\`\`opengym
{"action":"set_week","week":{"1":"Full body A","3":"rest"}}
\`\`\`

Override specific DATES, which beats the weekly pattern — for a trip, an illness, a one-off
swap. Keys are YYYY-MM-DD, values a routine name or "rest", and "clear" removes the override
so the day goes back to the weekly plan:
\`\`\`opengym
{"action":"plan_day","dates":{"${todayISO()}":"rest","2026-01-02":"Full body A","2026-01-03":"clear"}}
\`\`\`

Change app settings. Omit anything you are not changing:
\`\`\`opengym
{"action":"set_settings","restSec":120,"effort":"rir","sound":true,"keepAwake":true,"unit":"kg"}
\`\`\`
restSec 15-600. effort: none|rir|rpe — RIR is reps left in the tank, RPE is 6-10 difficulty;
only suggest one if the user is ready to judge effort per set. unit kg|lb changes the LABEL
only, it does not convert logged numbers, so never change it unasked.

Record a weigh-in (date optional, defaults to today), or set the body-weight target:
\`\`\`opengym
{"action":"log_bodyweight","weight":82.4}
\`\`\`
\`\`\`opengym
{"action":"set_goal","weight":75}
\`\`\`
\`\`\`opengym
{"action":"delete_routines","routines":["Full body A"]}
\`\`\`

EXERCISE FIELDS
name   required, from the library above
sets   1-${MAX_BW_SETS + 4}
reps   a plain number (not "8-12")
repsMax  optional ceiling for bodyweight work. Reaching it adds a SET and resets the reps —
         without it the app adds a rep forever. Set it ~8 above reps on any unweighted exercise.
sec    for a held or timed exercise (plank, mountain climber) instead of reps
side   true for one-side-at-a-time work. reps is then the TOTAL across both sides, so use an
       EVEN number: 16 means 8 per side.
weight in ${unit}, only for exercises that carry load. Omit for bodyweight work.
prog   how the app progresses it automatically: ${POLICIES_FOR.reps.join('/')} for reps,
       ${POLICIES_FOR.time.join('/')} for timed. Default linear/time is usually right.

COACHING RULES
Respect the profile above: never prescribe equipment the user does not have, never load a muscle
they flagged, keep each day inside the session length, and schedule onto the days they train.
Use the RECOVERY block when the question is about today: send them at something that is not
fatigued, and prefer a muscle that has had no sets in 30 days over one already leading the
volume. Never tell the user to add weight or reps to an exercise listed under AUTOMATIC
PROGRESSION — the app does that on its own, and saying otherwise makes it look broken.
Fewer than 3 sessions a week means full-body days, not a split — a split at that frequency trains
each muscle once a week. For a beginner, start below what they could grind out: the app adds reps
by itself every session that goes clean.

Rules: at most one block per reply; never invent user data. Explain your reasoning in prose
BEFORE the block, briefly. Write prose in ${langLine}, but keep exercise names inside the JSON
block in English.`
}

// ─────────────────────────────────────────────────────────── actions ──

export function parseActions(text) {
  const out = []
  const re = /```opengym\s*([\s\S]*?)```/g
  let m
  while ((m = re.exec(text)) !== null) {
    const v = safeParse(m[1].trim())
    if (v && v.action) out.push(v)
  }
  return out
}

export const stripActions = text => text.replace(/```opengym\s*[\s\S]*?```/g, '').trim()

const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()

// Name → exercise. Scored rather than first-hit: "row" matched "rowing machine" ahead of
// "barbell bent over row" purely on catalogue order.
export function findExercise(name, pool = EXDB) {
  const q = norm(name)
  if (!q) return null
  const qw = q.split(' ')
  let best = null, bestScore = 0
  for (const e of pool) {
    const n = norm(e.n)
    let score
    if (n === q) score = 1000
    else if (n.startsWith(q) || q.startsWith(n)) score = 500 - Math.abs(n.length - q.length)
    else if (n.includes(q)) score = 300 - (n.length - q.length)
    else {
      const nw = new Set(n.split(' '))
      const hit = qw.filter(w => nw.has(w)).length
      if (!hit) continue
      score = hit * 40 - Math.abs(nw.size - qw.length) * 3
      if (hit === qw.length) score += 60
    }
    if (score > bestScore) { bestScore = score; best = e }
  }
  return bestScore > 0 ? best : null
}

const GLYPH_SET = new Set(GLYPHS)
const clampSets = n => Math.min(10, Math.max(1, Math.round(Number(n) || 3)))
// Models like to answer "8-12"; the app stores a single number (the range lives in the
// progression policy), so take the low end rather than writing a string into cfg.reps.
const clampReps = v => {
  const m = String(v ?? '').match(/\d+/)
  return Math.min(100, Math.max(1, m ? parseInt(m[0], 10) : 10))
}
const num = (v, lo, hi, dflt) => {
  const n = Math.round(Number(v))
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt
}

// A calendar date, not just the shape of one: new Date('2026-02-30') rolls over to March 2,
// so the round trip is what actually rejects it. Used for both dayPlan keys and weigh-in dates.
export function isISODate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const d = new Date(s + 'T12:00:00')
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

// Body weight to one decimal. Below 20 or above 500 is a unit mix-up or a typo rather than a
// person, and either would wreck the weight chart's scale.
const weightVal = v => {
  const n = Math.round(Number(v) * 10) / 10
  return Number.isFinite(n) && n >= 20 && n <= 500 ? n : null
}

// Build store configs off defaultConfig so a cardio or bodyweight pick gets the right shape
// (min/speed, or the bodyweight flag) instead of a reps/weight config that the workout screen
// would then have to guess about.
//
// Everything past `sets` is a field the model may or may not send, and each one has a way of
// being wrong that the app cannot recover from later:
//   side     — an odd total puts a rep on one leg and not the other, so it is rounded up to even
//   repsMax  — a ceiling at or below reps would add a set on the very first session
//   prog     — a policy that does not exist for the mode silently degrades to 'off', i.e. no
//              progression at all, which is the single feature that makes a plan self-updating
//   weight   — load on a bodyweight exercise means ADDED load, and a model that fills in 20kg
//              for a push-up has invented a weight vest
function toConfigs(list, pool) {
  const ex = [], unmatched = []
  for (const item of list || []) {
    const found = findExercise(item?.name, pool)
    if (!found) { if (item?.name) unmatched.push(String(item.name)); continue }

    // An explicit sec means the model intends a hold, even for an exercise the catalogue files
    // as reps (plank variants are all reps in the dataset).
    const wantTime = item.sec != null && item.reps == null
    const cfg = defaultConfig(found.id, wantTime ? 'time' : undefined)
    cfg.sets = clampSets(item.sets)

    if (cfg.mode === 'reps') {
      const perSide = item.side === true || item.side === 'true'
      cfg.reps = clampReps(item.reps)
      if (perSide) {
        cfg.side = true
        if (cfg.reps % 2) cfg.reps += 1
      }
      const top = num(item.repsMax, 1, 200, 0)
      // A ceiling only means anything above the working reps; below it, every session would
      // trip the add-a-set branch immediately.
      if (top > cfg.reps) cfg.repsMax = perSide && top % 2 ? top + 1 : top
    } else if (cfg.mode === 'time') {
      cfg.sec = num(item.sec, 5, 600, cfg.sec)
      if (item.side === true) cfg.side = true
    } else if (cfg.min !== undefined) {
      cfg.min = num(item.min, 1, 180, cfg.min)
      if (item.speed != null) cfg.speed = Math.min(40, Math.max(1, Number(item.speed) || cfg.speed))
    }

    // Load. `bodyweight` on the config means the exercise carries none of its own, so a weight
    // here is added weight — accepted (weighted dips are real), but never invented from a
    // model's default of 0.
    if (cfg.weight !== undefined && item.weight != null) {
      cfg.weight = Math.min(1000, Math.max(0, Number(item.weight) || 0))
    }

    // Progression policy, validated against what the mode actually supports.
    const allowed = POLICIES_FOR[cfg.mode] || ['off']
    if (item.prog && allowed.includes(item.prog)) cfg.prog = item.prog
    // A timed exercise with no policy gets 'off' from policyFor, because reps default to linear
    // and nothing else does — so every plank the coach wrote sat at the same duration forever.
    // 'time' is the only progression a hold has, so it is the only sensible default.
    else if (cfg.mode === 'time') cfg.prog = 'time'

    ex.push({ id: found.id, ...cfg })
  }
  return { ex, unmatched }
}

// Applies one action to a draft of S (the producer passed to store.update). Returns a summary
// the caller can report; never throws on bad model output.
export function applyAction(S, action, opts = {}) {
  const pool = allExercises(S)
  const created = [], unmatched = []
  let scheduled = 0, added = 0, updated = 0, removed = 0, deleted = 0
  // The newer actions touch things that are not routines, so they are counted separately —
  // "applied" has to mean something specific enough for the toast to be honest.
  let settings = 0, logged = 0, goal = 0, dated = 0

  S.routines = S.routines || []
  S.week = S.week || {}
  S.dayPlan = S.dayPlan || {}
  S.bodyweight = S.bodyweight || []

  // Exact match, then a *scored* partial. The old version fell back to a bare two-way
  // substring test, which resolved the reference "A" to "Back day" -- 'back day'.includes('a')
  // is true. The coach names days "Full body A"/"Full body B" and then refers to them as "A"
  // and "B" in later turns, so that was a live path to writing into the wrong routine and
  // reporting success. Scoring prefers a word-boundary hit and the closest length, and a
  // reference shorter than 3 characters is only allowed to match on a whole word.
  const matchRoutine = name => {
    const target = norm(name)
    if (!target) return null
    const exact = S.routines.find(x => norm(x.name) === target)
    if (exact) return exact

    let best = null, bestScore = 0
    for (const r of S.routines) {
      const n = norm(r.name)
      const words = n.split(' ')
      // Containment is only meaningful when BOTH sides are long enough to be a real word.
      // Guarding only the reference still let a routine literally named "A" swallow any
      // reference containing an "a" ('nonexistent day'.includes('a')), which is the same
      // class of bug from the other direction. A short name can still match exactly, or as
      // a whole word.
      const long = target.length >= 3 && n.length >= 3
      let score = 0
      if (words.includes(target)) score = 400 - Math.abs(n.length - target.length)
      else if (long && (n.startsWith(target) || target.startsWith(n))) score = 300 - Math.abs(n.length - target.length)
      else if (long && (n.includes(target) || target.includes(n))) score = 200 - Math.abs(n.length - target.length)
      if (score > bestScore) { bestScore = score; best = r }
    }
    return best
  }

  // A day override holding a routine id that no longer exists outranks the weekly plan
  // (effectiveRoutineId reads dayPlan first), so that date reads "Rest" even after the user
  // reschedules the weekday. The week was already cleaned on delete; this was not.
  const dropDeadOverrides = () => {
    const live = new Set(S.routines.map(r => r.id))
    for (const [iso, v] of Object.entries(S.dayPlan || {})) {
      if (v !== 'rest' && !live.has(v)) delete S.dayPlan[iso]
    }
  }

  const resolveWeek = week => {
    for (const [day, name] of Object.entries(week || {})) {
      const d = Number(day)
      if (!Number.isInteger(d) || d < 0 || d > 6) continue
      if (!name || norm(name) === 'rest') { delete S.week[d]; continue }
      const r = matchRoutine(name)
      if (r) { S.week[d] = r.id; scheduled++ }
    }
  }

  if (action.action === 'create_plan') {
    // Replacing has to clear the week too: day assignments holding ids of deleted routines
    // no longer resolve, and every day silently reads "Rest".
    // dayPlan holds routine ids too and outranks the week, so a replace that skips it leaves
    // specific dates pointing at routines that no longer exist -- those dates then read
    // "Rest" no matter what the new weekly plan says.
    if (opts.replace) { S.routines = []; S.week = {}; S.dayPlan = {} }
    for (const r of action.routines || []) {
      if (!r || !r.name) continue
      const { ex, unmatched: miss } = toConfigs(r.exercises, pool)
      unmatched.push(...miss)
      const name = String(r.name).trim().slice(0, 40)
      const emoji = GLYPH_SET.has(r.glyph) ? r.glyph : 'figureStrength'
      // Asked a second time, the coach writes the same day names again — it is revising the plan,
      // not adding to it. Appending gave two "Full body A"s and a week pointing at the stale one.
      // Keeping the id means the week, and the history attached to it, stay put.
      const same = ex.length ? matchRoutine(name) : null
      if (same) {
        same.name = name
        same.emoji = emoji
        same.ex = ex
        updated++
        created.push(name)
        continue
      }
      const routine = { id: uid(), name, emoji, ex }
      S.routines.push(routine)
      created.push(routine.name)
    }
    resolveWeek(action.week)
  } else if (action.action === 'add_exercises') {
    const r = matchRoutine(action.routine)
    if (!r) return { ...empty(), ok: false, reason: 'no-routine', name: String(action.routine || '') }
    const { ex, unmatched: miss } = toConfigs(action.exercises, pool)
    unmatched.push(...miss)
    r.ex = [...(r.ex || []), ...ex]
    added = ex.length
  } else if (action.action === 'update_routine') {
    // Editing an existing day rather than making a fourth one. The coach could only ever append
    // before this, so "swap the wall push-ups for kneeling" produced a routine with both.
    const r = matchRoutine(action.routine)
    if (!r) return { ...empty(), ok: false, reason: 'no-routine', name: String(action.routine || '') }
    if (action.name) { r.name = String(action.name).trim().slice(0, 40); updated++ }
    if (GLYPH_SET.has(action.glyph)) { r.emoji = action.glyph; updated++ }
    if (action.exercises) {
      const { ex, unmatched: miss } = toConfigs(action.exercises, pool)
      unmatched.push(...miss)
      // An empty result means every name missed. Wiping the day in that case turns a typo into
      // data loss, so the old list stands and the caller reports the misses.
      if (ex.length) { r.ex = ex; updated++ }
    }
  } else if (action.action === 'remove_exercises') {
    const r = matchRoutine(action.routine)
    if (!r) return { ...empty(), ok: false, reason: 'no-routine', name: String(action.routine || '') }
    const targets = (action.exercises || []).map(x => (typeof x === 'string' ? x : x?.name)).filter(Boolean)
    const ids = new Set()
    for (const name of targets) {
      // Resolved against the routine's own exercises, not the whole catalogue: "remove the row"
      // means the row in this day.
      const inRoutine = (r.ex || []).map(e => EXIDX[e.id]).filter(Boolean)
      const hit = findExercise(name, inRoutine)
      if (hit) ids.add(hit.id); else unmatched.push(String(name))
    }
    if (ids.size) {
      const before = (r.ex || []).length
      r.ex = (r.ex || []).filter(e => !ids.has(e.id))
      removed = before - r.ex.length
    }
  } else if (action.action === 'delete_routines') {
    const names = action.routines || []
    for (const name of names) {
      const r = matchRoutine(name)
      if (!r) { unmatched.push(String(name)); continue }
      S.routines = S.routines.filter(x => x !== r)
      // A day pointing at a deleted routine resolves to nothing and silently reads "Rest",
      // which looks like the app forgot the plan rather than like a deletion.
      for (const [d, id] of Object.entries(S.week)) if (id === r.id) delete S.week[d]
      deleted++
    }
    dropDeadOverrides()
  } else if (action.action === 'set_week') {
    resolveWeek(action.week)
  } else if (action.action === 'plan_day') {
    // Date overrides, which outrank the weekly pattern (lib/history.js effectiveRoutineId).
    // The value is a routine name, 'rest', or 'clear' to drop the override entirely.
    for (const [iso, name] of Object.entries(action.dates || {})) {
      if (!isISODate(iso)) { unmatched.push(String(iso)); continue }
      const v = norm(name)
      if (v === 'clear') {
        if (S.dayPlan[iso] !== undefined) { delete S.dayPlan[iso]; dated++ }
        continue
      }
      if (v === 'rest') { S.dayPlan[iso] = 'rest'; dated++; continue }
      const r = matchRoutine(name)
      if (r) { S.dayPlan[iso] = r.id; dated++ } else unmatched.push(String(name))
    }
  } else if (action.action === 'set_settings') {
    // Only the keys listed here are writable, and each is validated rather than trusted.
    // Writing whatever the model sent straight into S would let one bad reply corrupt state
    // the app has no path to repair.
    if (action.restSec != null) {
      const v = num(action.restSec, 15, 600, null)
      if (v != null && v !== S.restSec) { S.restSec = v; settings++ }
    }
    if (action.effort != null) {
      const v = String(action.effort).toLowerCase()
      // 'none' is a real answer here (the column is off), so it is allowed alongside the scales.
      if ((v === 'none' || EFFORT[v]) && v !== effortOf(S)) {
        S.effort = v
        // showRir is the boolean `effort` replaced; leaving it set would flip the column back
        // on the next time state is merged over DEF (see effortOf).
        delete S.showRir
        settings++
      }
    }
    if (action.unit != null) {
      const v = String(action.unit).toLowerCase()
      if ((v === 'kg' || v === 'lb') && v !== S.unit) { S.unit = v; settings++ }
    }
    if (action.sound != null) {
      const v = !!action.sound
      if (v !== !!S.sound) { S.sound = v; settings++ }
    }
    if (action.keepAwake != null) {
      const v = !!action.keepAwake
      if (v !== (S.keepAwake !== false)) { S.keepAwake = v; settings++ }
    }
  } else if (action.action === 'log_bodyweight') {
    const w = weightVal(action.weight)
    const iso = isISODate(action.date) ? action.date : todayISO()
    if (w != null) {
      // Same shape and same one-entry-per-day rule as the manual weigh-in sheet, so a value
      // the coach logged is indistinguishable from one the user typed.
      const existing = S.bodyweight.find(b => b.d === iso)
      if (existing) { existing.w = w; existing.t = Date.now() } else S.bodyweight.push({ d: iso, w, t: Date.now() })
      S.bodyweight.sort((a, b) => (a.d < b.d ? -1 : 1))
      logged++
    }
  } else if (action.action === 'set_goal') {
    // 0 and null both mean "no target" — a goal of zero is not a thing, and storing it would
    // render as a target the user can never reach.
    if (action.weight == null || Number(action.weight) === 0) {
      if (S.targetW != null) { S.targetW = null; goal++ }
    } else {
      const w = weightVal(action.weight)
      if (w != null && w !== S.targetW) { S.targetW = w; goal++ }
    }
  } else {
    // The name travels with the failure. Without it the UI could only say "nothing to apply",
    // which is also what a well-formed action that matched nothing says — so an invented
    // action type and a typo'd routine name were indistinguishable to the user.
    return { ...empty(), ok: false, reason: 'unknown-action', name: String(action.action || '') }
  }

  const touched = created.length + scheduled + added + updated + removed + deleted
    + settings + logged + goal + dated
  return {
    ok: touched > 0, reason: touched ? null : 'nothing',
    created, unmatched, scheduled, added, updated, removed, deleted,
    settings, logged, goal, dated,
  }

  function empty() {
    return {
      created, unmatched, scheduled, added, updated, removed, deleted,
      settings, logged, goal, dated,
    }
  }
}

// What an action will do, for the button that applies it. There are six action types now, and a
// single "Apply this plan" button for all of them meant pressing one without knowing whether it
// added a routine or deleted three. Returns [label, detail] — both English source strings for t().
export function describeAction(action) {
  const a = action || {}
  const n = list => (Array.isArray(list) ? list.length : 0)
  switch (a.action) {
    case 'create_plan': {
      const days = Object.keys(a.week || {}).length
      return {
        label: 'Apply this plan',
        detail: days
          ? ['{0} routines, {1} days scheduled', n(a.routines), days]
          : ['{0} routines', n(a.routines)],
      }
    }
    case 'add_exercises':
      return { label: 'Add to routine', detail: ['{0} exercises → {1}', n(a.exercises), a.routine || '?'] }
    case 'update_routine':
      return { label: 'Update routine', detail: ['Rewrites {0}', a.routine || '?'] }
    case 'remove_exercises':
      return { label: 'Remove exercises', detail: ['{0} exercises out of {1}', n(a.exercises), a.routine || '?'] }
    case 'delete_routines':
      return { label: 'Delete routines', detail: ['{0} routines deleted', n(a.routines)] }
    case 'set_week':
      return { label: 'Assign to days', detail: ['{0} days', Object.keys(a.week || {}).length] }
    case 'plan_day':
      return { label: 'Change specific dates', detail: ['{0} dates', Object.keys(a.dates || {}).length] }
    case 'set_settings': {
      // Named, not counted: "2 settings" tells the user nothing about what is being changed,
      // and one of these (unit) does not convert their logged numbers.
      //
      // Returned as `parts` rather than a joined string: the caller runs each through t()
      // separately. Passing an already-joined "Rest timer · Weight unit" as a template
      // argument would substitute it verbatim and leave those names in English inside an
      // otherwise translated line.
      const parts = []
      if (a.restSec != null) parts.push('Rest timer')
      if (a.effort != null) parts.push('Effort per set')
      if (a.unit != null) parts.push('Weight unit')
      if (a.sound != null) parts.push('Sounds')
      if (a.keepAwake != null) parts.push('Keep screen awake')
      return { label: 'Change settings', detail: null, parts }
    }
    case 'log_bodyweight':
      // `value` is shown as-is, in its own field rather than as a template argument: a
      // bare-placeholder template returns the argument unchanged while adding a key with no
      // meaning of its own to every language pack.
      return { label: 'Log this weight', detail: null, value: String(a.weight ?? '?') }
    case 'set_goal':
      return a.weight == null || Number(a.weight) === 0
        ? { label: 'Clear the goal', detail: null }
        : { label: 'Set this goal', detail: null, value: String(a.weight) }
    default:
      return { label: 'Apply', detail: null }
  }
}

// ─────────────────────────────────────────── instruction translation ──

// Exercise steps ship in English for languages with no instr/ pack (Persian is one).
// Translated once per exercise per language and cached, because the exercise sheet is reopened
// constantly during a session and each visit would otherwise be another paid call.
const TKEY = 'gym_instr_tr_v1'
const readCache = () => { try { return JSON.parse(localStorage.getItem(TKEY)) || {} } catch { return {} } }

export const cachedInstr = (exId, lang) => readCache()[lang + ':' + exId] || null

function writeCache(exId, lang, steps) {
  try {
    const all = readCache()
    all[lang + ':' + exId] = steps
    const keys = Object.keys(all)
    if (keys.length > 400) keys.slice(0, keys.length - 400).forEach(k => delete all[k])
    localStorage.setItem(TKEY, JSON.stringify(all))
  } catch { /* the cache is an optimisation, not state */ }
}

const LANG_NAME = { fa: 'Persian (فارسی)', ar: 'Arabic', he: 'Hebrew', ur: 'Urdu' }

export async function translateInstructions({ steps, exName, lang, base, key, model }) {
  const numbered = steps.map((s, i) => `${i + 1}. ${s}`).join('\n')
  const reply = await chatComplete({
    base, key, model, temperature: 0.2, maxTokens: 900,
    messages: [
      { role: 'system', content: `Translate gym exercise instructions into ${LANG_NAME[lang] || lang}. Output ONLY the translated steps, one per line, numbered "1." "2." etc, with the same number of steps as the input. No preamble, no notes.` },
      { role: 'user', content: `Exercise: ${exName}\n${numbered}` },
    ],
  })
  const lines = reply.split('\n').map(l => l.replace(/^\s*\d+[.)]\s*/, '').trim()).filter(Boolean)
  if (!lines.length) throw new Error('Empty translation')
  return lines
}

export async function translateAndCache(args) {
  const lines = await translateInstructions(args)
  writeCache(args.exId, args.lang, lines)
  return lines
}
