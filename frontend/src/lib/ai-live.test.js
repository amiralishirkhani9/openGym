import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { apiJSON, chatUrl, modelsUrl, listModels, buildSystemPrompt, parseActions, stripActions, applyAction } from './ai.js'
import { EXIDX } from './exercises.js'
import { modeOf, isPerSide } from './history.js'
import { policyFor } from './progression.js'
import { poolFor } from './coachcatalog.js'

// End-to-end over real HTTP against a real (if small) OpenAI-compatible server, rather than a
// stubbed fetch. Everything from here down is production code: the transport, the prompt, the
// block parser and the store write.
//
// The server is what makes this worth having — it plays the part of a model that answers using
// ONLY the exercise library it was handed in the system prompt. That is the contract the coach
// depends on, and it is the one a canned reply cannot check.

let server, base
const seen = []

// Stands in for the model: reads the EXERCISE LIBRARY section out of the system prompt and builds
// a plan from names it finds there. Deliberately literal — it proves the prompt carries enough
// information to answer from, and that what comes back survives the round trip.
function fakeModel(messages) {
  const system = messages.find(m => m.role === 'system')?.content || ''
  const lib = system.split('EXERCISE LIBRARY')[1]?.split('WRITING TO THE PLAN')[0] || ''
  const byTarget = {}
  for (const line of lib.split('\n')) {
    const i = line.indexOf(': ')
    if (i < 0) continue
    byTarget[line.slice(0, i).trim()] = line.slice(i + 2).split(', ').map(s => s.trim())
  }
  const pick = (tg, n = 0) => (byTarget[tg] || [])[n]
  const day = (name, glyph) => ({
    name, glyph,
    exercises: [
      { name: pick('quads'), sets: 3, reps: 12, repsMax: 20 },
      { name: pick('pectorals'), sets: 3, reps: 10, repsMax: 18 },
      { name: pick('upper back'), sets: 3, reps: 12, repsMax: 20 },
      { name: pick('glutes'), sets: 3, reps: 14, repsMax: 22 },
      { name: pick('abs'), sets: 3, reps: 16, repsMax: 24, side: true },
    ].filter(e => e.name),
  })
  const action = {
    action: 'create_plan',
    routines: [day('Full body A', 'figureStrength'), day('Full body B', 'legs')],
    week: { 6: 'Full body A', 1: 'Full body B' },
  }
  return 'سه روز تمام‌بدن، بدون وسیله.\n\n```opengym\n' + JSON.stringify(action) + '\n```'
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', d => { raw += d })
    req.on('end', () => {
      const parsed = raw ? JSON.parse(raw) : null
      seen.push({ url: req.url, method: req.method, auth: req.headers.authorization, body: parsed })
      const json = o => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)) }

      if (req.url === '/v1/models') {
        return json({ data: [{ id: 'openai/gpt-test', owned_by: 'openai' }, { id: 'local-model' }] })
      }
      if (req.url === '/v1/chat/completions') {
        // A wrong key has to come back as the provider's own message, not "HTTP 401".
        if (req.headers.authorization !== 'Bearer sk-test') {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          return res.end(JSON.stringify({ error: { message: 'Incorrect API key provided' } }))
        }
        return json({ choices: [{ message: { role: 'assistant', content: fakeModel(parsed?.messages || []) } }] })
      }
      res.writeHead(404); res.end('nope')
    })
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}`
})

afterAll(() => new Promise(r => server.close(r)))

const state = (over = {}) => ({
  unit: 'kg', routines: [], week: {}, workouts: [], bodyweight: [], customEx: [],
  targetW: null, coach: null, ...over,
})

const ask = async (S, lang = 'en', text = 'build') => {
  const data = await apiJSON({
    url: chatUrl(base), method: 'POST', key: 'sk-test',
    body: {
      model: 'openai/gpt-test',
      messages: [
        { role: 'system', content: buildSystemPrompt(S, lang) },
        { role: 'user', content: text },
      ],
    },
  })
  return data.choices[0].message.content
}

describe('coach over real HTTP', () => {
  it('discovers models from a live endpoint', async () => {
    const list = await listModels(base, 'sk-test')
    expect(list.map(m => m.id)).toContain('openai/gpt-test')
    expect(list.find(m => m.id === 'openai/gpt-test').provider).toBe('OpenAI')
    expect(modelsUrl(base)).toBe(base + '/v1/models')
  })

  it('surfaces the provider error text on a bad key', async () => {
    await expect(apiJSON({
      url: chatUrl(base), method: 'POST', key: 'wrong',
      body: { model: 'x', messages: [] },
    })).rejects.toThrow('Incorrect API key provided')
  })

  it('builds a plan from the profile and writes it to the store', async () => {
    const S = state({
      coach: {
        _set: true, level: 'beginner', days: [6, 1, 3], place: 'home_none',
        goals: ['fat_loss', 'strength'], sessionMin: 45, limits: [], notes: '',
      },
    })

    const reply = await ask(S, 'fa', 'از پروفایلم برنامه بساز')
    const actions = parseActions(reply)
    expect(actions).toHaveLength(1)
    // The JSON never reaches the user; the prose does.
    expect(stripActions(reply)).not.toContain('opengym')
    expect(stripActions(reply)).toContain('تمام‌بدن')

    const res = applyAction(S, actions[0])
    expect(res.ok).toBe(true)
    expect(res.created).toHaveLength(2)
    expect(res.unmatched).toEqual([])
    expect(res.scheduled).toBe(2)

    // Every row is real, doable with no equipment, and progresses by itself.
    const home = new Set(poolFor({ place: 'home_none', limits: [] }).map(e => e.id))
    for (const r of S.routines) {
      expect(r.ex.length).toBeGreaterThan(3)
      for (const e of r.ex) {
        const ex = EXIDX[e.id]
        expect(ex, e.id).toBeTruthy()
        expect(ex.eq, ex.n).toBe('body weight')
        expect(home.has(e.id), `${ex.n} needs equipment`).toBe(true)
        expect(policyFor(e, r, modeOf(e)), ex.n).not.toBe('off')
        if (modeOf(e) === 'reps' && isPerSide(e)) expect(e.reps % 2).toBe(0)
      }
    }
    expect(S.week[6]).toBe(S.routines[0].id)
    expect(S.week[1]).toBe(S.routines[1].id)
  })

  it('sends the key as a bearer token and the model in the body', async () => {
    const call = seen.find(r => r.url === '/v1/chat/completions' && r.auth === 'Bearer sk-test')
    expect(call).toBeTruthy()
    expect(call.body.model).toBe('openai/gpt-test')
    expect(call.body.messages[0].role).toBe('system')
  })

  it('gives a gym profile loaded work over the same wire', async () => {
    const S = state({ coach: { _set: true, place: 'gym_full', days: [1, 3, 5], sessionMin: 60 } })
    const res = applyAction(S, parseActions(await ask(S))[0])
    expect(res.ok).toBe(true)
    // The fake model only ever picks from the library it was handed, so a non-bodyweight pick
    // here proves the equipment filter actually widened for a gym.
    const eqs = new Set(S.routines.flatMap(r => r.ex).map(e => EXIDX[e.id].eq))
    expect(eqs.size).toBeGreaterThan(0)
    expect([...eqs].every(e => e === 'body weight')).toBe(false)
  })

  it('keeps a knee-injury profile off the quads, end to end', async () => {
    const S = state({ coach: { _set: true, place: 'home_none', limits: ['knee'], days: [1, 3, 5] } })
    applyAction(S, parseActions(await ask(S))[0])
    const targets = S.routines.flatMap(r => r.ex).map(e => EXIDX[e.id].tg)
    expect(targets.length).toBeGreaterThan(0)
    expect(targets).not.toContain('quads')
  })

  it('updates an existing plan instead of only creating one', async () => {
    // The second build must not stack a second copy of the week on top of the first.
    const S = state({ coach: { _set: true, place: 'home_none', days: [6, 1, 3] } })
    applyAction(S, parseActions(await ask(S))[0])
    const firstIds = S.routines.map(r => r.id)
    applyAction(S, parseActions(await ask(S))[0])
    expect(S.routines).toHaveLength(2)
    expect(S.routines.map(r => r.id)).toEqual(firstIds)
    expect(Object.keys(S.week).sort()).toEqual(['1', '6'])
  })
})
