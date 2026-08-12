import { afterEach, describe, expect, it, vi } from 'vitest'
import { apiRoot, chatUrl, modelsUrl, messagesUrl, wireFor, splitSystem, chatComplete, parseActions, stripActions, findExercise, applyAction, buildSystemPrompt, apiJSON, listModels } from './ai.js'
import { EXIDX } from './exercises.js'

const state = (over = {}) => ({
  unit: 'kg', routines: [], week: {}, workouts: [], bodyweight: [], customEx: [], targetW: null, ...over,
})

// People paste whatever their provider's docs showed them: a bare host, the /v1 root, or the
// full completions endpoint. All three have to end up at the same place, or the request 404s
// with a message that says nothing about the real problem.
describe('apiRoot', () => {
  it('normalises every shape of pasted base URL', () => {
    for (const input of [
      'api.openai.com',
      'https://api.openai.com',
      'https://api.openai.com/',
      'https://api.openai.com/v1',
      'https://api.openai.com/v1/',
      'https://api.openai.com/v1/chat/completions',
      'https://api.openai.com/v1/models',
      '  https://api.openai.com/v1  ',
    ]) {
      expect(chatUrl(input)).toBe('https://api.openai.com/v1/chat/completions')
    }
  })

  it('keeps a provider path prefix', () => {
    expect(chatUrl('https://openrouter.ai/api/v1')).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(modelsUrl('openrouter.ai/api')).toBe('https://openrouter.ai/api/v1/models')
  })

  it('leaves a local http endpoint on http', () => {
    expect(chatUrl('http://localhost:11434/v1')).toBe('http://localhost:11434/v1/chat/completions')
  })

  it('is empty for empty input rather than inventing a host', () => {
    expect(apiRoot('')).toBe('')
    expect(apiRoot(null)).toBe('')
  })
})

// Anthropic is the one provider that is not OpenAI-shaped. It is selected from the host rather
// than from a second question in the setup form, so these tests pin the detection as much as
// the request shape.
describe('the Anthropic wire', () => {
  afterEach(() => { delete globalThis.fetch })

  const capture = (reply = { content: [{ type: 'text', text: 'hi' }] }) => {
    const calls = []
    globalThis.fetch = async (url, opts) => {
      calls.push({ url, opts, body: JSON.parse(opts.body) })
      return { ok: true, status: 200, text: async () => JSON.stringify(reply) }
    }
    return calls
  }

  it('is chosen for api.anthropic.com and nothing else', () => {
    expect(wireFor('https://api.anthropic.com')).toBe('anthropic')
    expect(wireFor('api.anthropic.com/v1')).toBe('anthropic')
    expect(wireFor('https://api.openai.com/v1')).toBe('openai')
    expect(wireFor('https://anthropic.com.evil.test/v1')).toBe('openai')
    expect(wireFor('http://localhost:11434/v1')).toBe('openai')
  })

  it('posts to /v1/messages with the key in x-api-key, never as a bearer token', async () => {
    const calls = capture()
    await chatComplete({
      base: 'https://api.anthropic.com', key: 'sk-ant-test', model: 'claude-3-5-haiku-latest',
      messages: [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'hello' }],
    })
    expect(calls[0].url).toBe(messagesUrl('https://api.anthropic.com'))
    expect(calls[0].opts.headers['x-api-key']).toBe('sk-ant-test')
    expect(calls[0].opts.headers['anthropic-version']).toBe('2023-06-01')
    expect(calls[0].opts.headers.Authorization).toBeUndefined()
  })

  it('hoists the system turn out of messages[] and keeps max_tokens', async () => {
    const calls = capture()
    await chatComplete({
      base: 'https://api.anthropic.com', key: 'k', model: 'claude-x', maxTokens: 1234,
      messages: [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'hello' }],
    })
    expect(calls[0].body.system).toBe('be brief')
    expect(calls[0].body.messages).toEqual([{ role: 'user', content: 'hello' }])
    expect(calls[0].body.max_tokens).toBe(1234)
  })

  it('joins the text blocks of the reply', async () => {
    capture({ content: [{ type: 'text', text: 'part one ' }, { type: 'thinking', thinking: 'ignored' }, { type: 'text', text: 'part two' }] })
    const out = await chatComplete({
      base: 'https://api.anthropic.com', key: 'k', model: 'claude-x',
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(out).toBe('part one part two')
  })

  it('still reads choices[] when the provider is OpenAI-shaped', async () => {
    const calls = capture({ choices: [{ message: { content: 'from openai' } }] })
    const out = await chatComplete({
      base: 'https://api.openai.com/v1', key: 'sk-test', model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(calls[0].url).toBe(chatUrl('https://api.openai.com/v1'))
    expect(calls[0].opts.headers.Authorization).toBe('Bearer sk-test')
    expect(out).toBe('from openai')
  })
})

// Anthropic rejects an empty turn list, a leading assistant turn, and two turns in a row with
// the same role — all three are reachable from a real chat log.
describe('splitSystem', () => {
  it('merges consecutive same-role turns', () => {
    const { messages } = splitSystem([
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' },
      { role: 'assistant', content: 'c' },
    ])
    expect(messages).toEqual([
      { role: 'user', content: 'a\n\nb' },
      { role: 'assistant', content: 'c' },
    ])
  })

  it('never produces an empty list or a leading assistant turn', () => {
    expect(splitSystem([]).messages[0].role).toBe('user')
    expect(splitSystem([{ role: 'system', content: 's' }]).messages[0].role).toBe('user')
    expect(splitSystem([{ role: 'assistant', content: 'hi' }]).messages[0].role).toBe('user')
  })

  it('concatenates multiple system turns', () => {
    expect(splitSystem([
      { role: 'system', content: 'one' },
      { role: 'system', content: 'two' },
      { role: 'user', content: 'q' },
    ]).system).toBe('one\n\ntwo')
  })
})

describe('parseActions', () => {
  it('extracts a block and strips it from the prose', () => {
    const reply = 'Here is your plan.\n\n```opengym\n{"action":"set_week","week":{"1":"Push"}}\n```'
    expect(parseActions(reply)).toEqual([{ action: 'set_week', week: { 1: 'Push' } }])
    expect(stripActions(reply)).toBe('Here is your plan.')
  })

  it('ignores prose with no block, and malformed JSON', () => {
    expect(parseActions('Just some advice.')).toEqual([])
    expect(parseActions('```opengym\n{"action":"set_week",\n```')).toEqual([])
  })

  it('ignores a plain json block — only the tagged one is an instruction', () => {
    expect(parseActions('```json\n{"action":"set_week","week":{}}\n```')).toEqual([])
  })
})

// The matcher decides whether "bench press" becomes a bench press or something absurd, and it
// is the difference between a usable plan and one the user has to redo by hand.
describe('findExercise', () => {
  it('prefers the specific name over an earlier catalogue entry', () => {
    expect(findExercise('barbell bench press').n).toContain('bench press')
    expect(findExercise('barbell bent over row').n).toContain('row')
  })

  it('matches regardless of case and punctuation', () => {
    const a = findExercise('Barbell Bench Press')
    const b = findExercise('barbell-bench-press')
    expect(a.id).toBe(b.id)
  })

  it('returns null rather than a wrong guess for nonsense', () => {
    expect(findExercise('flurbo zzzzq')).toBe(null)
    expect(findExercise('')).toBe(null)
  })
})

describe('applyAction: create_plan', () => {
  it('creates routines and schedules them by name', () => {
    const S = state()
    const res = applyAction(S, {
      action: 'create_plan',
      routines: [
        { name: 'Push', glyph: 'barbell', exercises: [{ name: 'barbell bench press', sets: 4, reps: 8 }] },
        { name: 'Pull', exercises: [{ name: 'barbell bent over row', sets: 4, reps: 8 }] },
      ],
      week: { 1: 'Push', 3: 'Pull' },
    })
    expect(res.ok).toBe(true)
    expect(S.routines.map(r => r.name)).toEqual(['Push', 'Pull'])
    expect(S.routines[0].emoji).toBe('barbell')
    expect(S.week[1]).toBe(S.routines[0].id)
    expect(S.week[3]).toBe(S.routines[1].id)
    expect(res.scheduled).toBe(2)
  })

  it('falls back to the default glyph for one the picker does not offer', () => {
    const S = state()
    applyAction(S, { action: 'create_plan', routines: [{ name: 'X', glyph: '💪', exercises: [] }] })
    expect(S.routines[0].emoji).toBe('figureStrength')
  })

  it('reports unmatched names instead of dropping them silently', () => {
    const S = state()
    const res = applyAction(S, {
      action: 'create_plan',
      routines: [{ name: 'Push', exercises: [{ name: 'barbell bench press' }, { name: 'flurbo zzzzq' }] }],
    })
    expect(S.routines[0].ex).toHaveLength(1)
    expect(res.unmatched).toEqual(['flurbo zzzzq'])
  })

  it('produces a config the workout screen can read', () => {
    const S = state()
    applyAction(S, { action: 'create_plan', routines: [{ name: 'Push', exercises: [{ name: 'barbell bench press', sets: 4, reps: 8 }] }] })
    const cfg = S.routines[0].ex[0]
    expect(EXIDX[cfg.id]).toBeTruthy()
    expect(cfg).toMatchObject({ sets: 4, reps: 8, weight: 0, mode: 'reps' })
  })

  // A model asked for 8-12 reps writes "8-12"; the store holds one number, and a string there
  // renders as NaN in the set rows.
  it('takes the low end of a rep range and clamps absurd set counts', () => {
    const S = state()
    applyAction(S, { action: 'create_plan', routines: [{ name: 'P', exercises: [{ name: 'barbell bench press', sets: 99, reps: '8-12' }] }] })
    expect(S.routines[0].ex[0].reps).toBe(8)
    expect(S.routines[0].ex[0].sets).toBe(10)
  })

  it('clears stale day assignments when replacing the plan', () => {
    const S = state({ routines: [{ id: 'old', name: 'Old', emoji: 'barbell', ex: [] }], week: { 2: 'old' } })
    applyAction(S, { action: 'create_plan', routines: [{ name: 'New', exercises: [] }] }, { replace: true })
    expect(S.routines).toHaveLength(1)
    expect(S.routines[0].name).toBe('New')
    expect(S.week[2]).toBeUndefined()
  })

  it('keeps existing routines when not replacing', () => {
    const S = state({ routines: [{ id: 'old', name: 'Old', emoji: 'barbell', ex: [] }], week: { 2: 'old' } })
    applyAction(S, { action: 'create_plan', routines: [{ name: 'New', exercises: [] }] })
    expect(S.routines.map(r => r.name)).toEqual(['Old', 'New'])
    expect(S.week[2]).toBe('old')
  })
})

describe('applyAction: add_exercises', () => {
  it('appends to a routine matched loosely by name', () => {
    const S = state({ routines: [{ id: 'r1', name: 'Pull Day', emoji: 'barbell', ex: [] }] })
    const res = applyAction(S, { action: 'add_exercises', routine: 'pull', exercises: [{ name: 'barbell bent over row', sets: 3, reps: 10 }] })
    expect(res.ok).toBe(true)
    expect(S.routines[0].ex).toHaveLength(1)
  })

  it('says so when the routine does not exist', () => {
    const S = state()
    const res = applyAction(S, { action: 'add_exercises', routine: 'Ghost', exercises: [{ name: 'barbell bench press' }] })
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('no-routine')
  })
})

describe('applyAction: set_week', () => {
  it('assigns and clears days', () => {
    const S = state({ routines: [{ id: 'r1', name: 'Push', emoji: 'barbell', ex: [] }], week: { 5: 'r1' } })
    applyAction(S, { action: 'set_week', week: { 1: 'Push', 5: 'rest' } })
    expect(S.week[1]).toBe('r1')
    expect(S.week[5]).toBeUndefined()
  })

  it('ignores out-of-range days and unknown routine names', () => {
    const S = state({ routines: [{ id: 'r1', name: 'Push', emoji: 'barbell', ex: [] }] })
    const res = applyAction(S, { action: 'set_week', week: { 9: 'Push', 2: 'Nope' } })
    expect(res.ok).toBe(false)
    expect(S.week).toEqual({})
  })
})

describe('applyAction: bad input', () => {
  it('rejects an unknown action without throwing', () => {
    const S = state()
    expect(applyAction(S, { action: 'drop_database' }).ok).toBe(false)
  })

  it('reports nothing-applied for an empty plan', () => {
    const S = state()
    expect(applyAction(S, { action: 'create_plan', routines: [] }).reason).toBe('nothing')
  })
})

// The coach's whole value is that it knows what the user has. If the prompt does not carry the
// plan, it answers in generalities and claims it cannot see the app.
describe('buildSystemPrompt', () => {
  it('includes the routines, the schedule and the unit', () => {
    const S = state({
      unit: 'lb',
      routines: [{ id: 'r1', name: 'Push', emoji: 'barbell', ex: [{ id: '0025', sets: 4, reps: 8, weight: 60, mode: 'reps' }] }],
      week: { 1: 'r1' },
      bodyweight: [{ d: '2026-08-01', w: 80 }],
    })
    const p = buildSystemPrompt(S, 'fa')
    expect(p).toContain('"Push"')
    expect(p).toContain('Monday=Push')
    expect(p).toContain('unit: lb')
    expect(p).toContain('80lb')
    expect(p).toContain('Persian')
    expect(p).toContain('create_plan')
  })

  it('says so plainly when there is nothing yet', () => {
    const p = buildSystemPrompt(state(), 'en')
    expect(p).toContain('(none yet)')
  })
})

// The transport reads the body exactly once. Reading it twice is what produced
// "Unexpected non-whitespace character after JSON at position N" on the native build, and a
// provider's own error text is far more useful than the status code that carried it.
describe('apiJSON', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  const stub = (status, body, contentType = 'application/json') => {
    const fn = vi.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      text: async () => typeof body === 'string' ? body : JSON.stringify(body),
      headers: { get: () => contentType },
    }))
    vi.stubGlobal('fetch', fn)
    return fn
  }

  it('returns the parsed body and sends the auth header once', async () => {
    const fn = stub(200, { choices: [{ message: { content: 'hi' } }] })
    const out = await apiJSON({ url: 'https://x.dev/v1/chat/completions', method: 'POST', key: 'sk-1', body: { model: 'm' } })
    expect(out.choices[0].message.content).toBe('hi')
    expect(fn).toHaveBeenCalledTimes(1)
    const [, init] = fn.mock.calls[0]
    expect(init.headers.Authorization).toBe('Bearer sk-1')
    expect(init.headers['Content-Type']).toBe('application/json')
    expect(JSON.parse(init.body)).toEqual({ model: 'm' })
  })

  it('surfaces the provider message on an error status', async () => {
    stub(401, { error: { message: 'Incorrect API key provided' } })
    await expect(apiJSON({ url: 'https://x.dev/v1/models', key: 'bad' }))
      .rejects.toThrow('Incorrect API key provided')
  })

  it('falls back to the status when the error body is not JSON', async () => {
    stub(502, '<html>bad gateway</html>', 'text/html')
    await expect(apiJSON({ url: 'https://x.dev/v1/models' })).rejects.toThrow('HTTP 502')
  })

  it('rejects a 200 that is not JSON rather than returning undefined', async () => {
    stub(200, 'not json at all', 'text/plain')
    await expect(apiJSON({ url: 'https://x.dev/v1/models' })).rejects.toThrow('Malformed response')
  })

  it('omits the body and content-type on a GET', async () => {
    const fn = stub(200, { data: [] })
    await apiJSON({ url: 'https://x.dev/v1/models', key: 'k' })
    const [, init] = fn.mock.calls[0]
    expect(init.body).toBeUndefined()
    expect(init.headers['Content-Type']).toBeUndefined()
  })
})

describe('listModels', () => {
  afterEach(() => { vi.unstubAllGlobals() })
  const stub = body => vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true, status: 200, text: async () => JSON.stringify(body), headers: { get: () => 'application/json' },
  })))

  it('reads the OpenAI shape and groups by provider', async () => {
    stub({ data: [{ id: 'gpt-4o-mini', owned_by: 'openai' }, { id: 'meta-llama/llama-3-70b' }] })
    const list = await listModels('api.openai.com', 'k')
    expect(list.map(m => m.id)).toContain('gpt-4o-mini')
    expect(list.find(m => m.id === 'meta-llama/llama-3-70b')).toMatchObject({ name: 'llama-3-70b', provider: 'Meta' })
  })

  it('accepts a bare array of ids', async () => {
    stub(['a-model', 'b-model'])
    expect((await listModels('x.dev', 'k')).map(m => m.id)).toEqual(['a-model', 'b-model'])
  })

  it('returns an empty list rather than throwing on an unexpected shape', async () => {
    stub({ object: 'list' })
    expect(await listModels('x.dev', 'k')).toEqual([])
  })
})
