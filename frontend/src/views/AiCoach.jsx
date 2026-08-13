// AI coach — a chat that can read the plan and write to it.
//
// Deliberately not a tab: the five tabs are the app's own screens, and a coach you have to
// bring your own API key for is not one of them. It is reached from Settings and from the Plan
// header, and it is the only screen in the app that talks to a third party.
//
// The transport, the prompt and the plan-writing live in lib/ai.js; this file is the screen.

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { t, getLang } from '../lib/i18n.js'
import { hasProfile } from '../lib/coachprofile.js'
import { useAi, aiReady, setAi } from '../lib/aiconfig.js'
import { chatComplete, buildSystemPrompt, parseActions, stripActions, applyAction, describeAction } from '../lib/ai.js'
import { aiSetupSheet, coachProfileSheet } from '../sheets.jsx'
import Icon from '../components/Icon.jsx'
import { Button } from '../components/ui.jsx'

const CHAT_KEY = 'gym_ai_chat_v1'
const loadChat = () => { try { return JSON.parse(localStorage.getItem(CHAT_KEY)) || [] } catch { return [] } }
// Only the last 40 turns are kept: this sits in localStorage next to the training log, which
// matters more, and a coach does not need to remember last month's small talk.
const saveChat = m => { try { localStorage.setItem(CHAT_KEY, JSON.stringify(m.slice(-40))) } catch { /* full */ } }

// The first two write to the plan; the profile sheet is what makes them specific enough to be
// worth pressing. The others are read-only questions about data the coach can already see.
const SUGGESTIONS = [
  'Build a plan from my profile',
  'Review my current plan',
  // The coach can now read per-muscle fatigue and retained strength out of the log, so this
  // is answerable from data rather than from the weekly plan. It was the most obvious thing
  // to want from a coach and the one thing it could not do.
  'What should I train today?',
  'Make this week easier',
  'Swap an exercise I dislike',
]

export default function AiCoach() {
  const nav = useNavigate()
  const S = useStore(s => s.S)
  const update = useStore(s => s.update)
  const toast = useUI(s => s.toast)
  const cfg = useAi()

  const [msgs, setMsgs] = useState(loadChat)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const scroller = useRef(null)
  const abort = useRef(null)

  useEffect(() => saveChat(msgs), [msgs])
  // Layout effect, not effect: scrolling after paint makes the last bubble visibly jump.
  useLayoutEffect(() => {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [msgs, busy])
  useEffect(() => () => abort.current?.abort(), [])

  const ready = aiReady(cfg)
  const profileSet = hasProfile(S)
  // Sent after the profile sheet saves. The prompt is rebuilt per turn from state, so by the time
  // this runs the new profile is already in it — the message only has to say "go".
  const buildFromProfile = () => send(t('Build a plan from my profile'))

  const send = async text => {
    const body = (text ?? input).trim()
    if (!body || busy) return
    if (!ready) { aiSetupSheet(); return }

    const next = [...msgs, { id: Date.now(), role: 'user', content: body }]
    setMsgs(next)
    setInput('')
    setBusy(true)

    abort.current = new AbortController()
    try {
      // The prompt is rebuilt every turn from current state, so a plan the coach just wrote is
      // visible to it on the next question instead of it working from a stale snapshot.
      const messages = [
        { role: 'system', content: buildSystemPrompt(S, getLang()) },
        ...next.slice(-12).map(m => ({ role: m.role, content: m.content })),
      ]
      const reply = await chatComplete({
        base: cfg.base, key: cfg.key, model: cfg.model, messages,
        temperature: 0.7, maxTokens: 2000, signal: abort.current.signal,
      })
      if (!reply) throw new Error(t('No response from API'))
      const actions = parseActions(reply)
      setMsgs(m => [...m, {
        id: Date.now() + 1, role: 'assistant',
        content: stripActions(reply) || reply,
        actions: actions.length ? actions : undefined,
      }])
    } catch (e) {
      if (e.name === 'AbortError') return
      setMsgs(m => [...m, { id: Date.now() + 1, role: 'assistant', content: '⚠️ ' + (e.message || t('Cannot connect')), error: true }])
    } finally {
      setBusy(false)
      abort.current = null
    }
  }

  // Applying is one store.update per action so the whole thing is a single persisted change,
  // and the result is reported from what actually landed rather than from what was asked for.
  const apply = (action, msgId, opts) => {
    let res = null
    update(s => { res = applyAction(s, action, opts) })
    if (!res?.ok) {
      // The name comes back with the failure, so "which routine?" is answerable. Without it
      // an invented action type and a mistyped routine name produced the same dead-end toast.
      toast(res?.reason === 'no-routine' ? t('Routine not found') + (res.name ? ': ' + res.name : '')
        : res?.reason === 'unknown-action' ? t('The coach asked for something this app cannot do')
          : res?.unmatched?.length ? t('No matching exercises found')
            : t('Nothing to apply'))
      return
    }
    setMsgs(m => m.map(x => x.id === msgId ? { ...x, applied: true } : x))
    if (res.unmatched.length) toast(t('Plan applied') + ' · ' + res.unmatched.length + ' ✕')
    else if (res.created.length) toast(t('{0} routines created', res.created.length))
    else if (res.deleted) toast(t('{0} routines deleted', res.deleted))
    else if (res.removed) toast(t('{0} exercises removed', res.removed))
    else if (res.added) toast(t('{0} exercises added', res.added))
    else if (res.logged) toast(t('Weight logged'))
    else if (res.goal) toast(t('Goal updated'))
    else if (res.settings) toast(t('Settings updated'))
    else if (res.dated) toast(t('{0} days', res.dated))
    else toast(t('Plan applied'))
    // Land on the screen that changed. Settings and weigh-ins are not the plan, so sending
    // those to /plan showed the user a screen where nothing had visibly happened.
    const dest = res.logged || res.goal ? '/stats' : res.settings ? null : '/plan'
    if (dest) setTimeout(() => nav(dest), 450)
  }

  const clear = () => { setMsgs([]); saveChat([]); toast(t('Chat cleared')) }

  // Asking for a plan before the profile exists gets a generic plan, which is the failure this
  // screen is supposed to fix — so the form comes first, and sends the request on save.
  const BUILD = 'Build a plan from my profile'
  const ask = s => {
    if (s === BUILD && !profileSet) { coachProfileSheet(buildFromProfile); return }
    send(t(s))
  }

  return <div className="narrow aic">
    <div className="hdr">
      <div>
        <h1>{t('AI Coach')}</h1>
        <div className="sub">{ready ? (cfg.model || '').split('/').pop() : t('Set up the AI coach')}</div>
      </div>
      <div className="row" style={{ gap: 6 }}>
        {msgs.length > 0 && <button className="iconbtn" onClick={clear} aria-label={t('Clear chat')} title={t('Clear chat')}><Icon name="trash" /></button>}
        <button className="iconbtn" onClick={() => coachProfileSheet(buildFromProfile)} aria-label={t('Your training profile')} title={t('Your training profile')}><Icon name="person" /></button>
        <button className="iconbtn" onClick={aiSetupSheet} aria-label={t('AI Coach Setup')} title={t('AI Coach Setup')}><Icon name="gear" /></button>
      </div>
    </div>

    {!ready ? <div className="empty">
      <div className="ico"><Icon name="sparkles" /></div>
      {t('Connect your OpenAI-compatible API to use the AI coach.')}
      <div style={{ height: 14 }} />
      <Button variant="primary" icon="key" onClick={aiSetupSheet}>{t('AI Coach Setup')}</Button>
    </div> : <>
      <div className="aic-log" ref={scroller}>
        {msgs.length === 0 && <div className="aic-intro">
          <div className="ico"><Icon name="sparkles" /></div>
          <div>{t('Ask me anything about training, nutrition, or let me build your plan.')}</div>
          <div className="small dim" style={{ marginTop: 6 }}>{t('I can read your plan and change it directly.')}</div>
          <div style={{ height: 14 }} />
          <Button variant={profileSet ? 'plain' : 'primary'} icon="person" onClick={() => coachProfileSheet(buildFromProfile)}>
            {profileSet ? t('Edit my training profile') : t('Set up my training profile')}
          </Button>
          <div className="aic-sugg">
            {SUGGESTIONS.map(s => <button key={s} className="chip" onClick={() => ask(s)}>{t(s)}</button>)}
          </div>
        </div>}

        {msgs.map(m => <div key={m.id} className={'aic-m ' + m.role + (m.error ? ' err' : '')}>
          <div className="aic-b">{m.content}</div>
          {m.actions && !m.applied && <div className="aic-acts">
            {m.actions.map((a, i) => {
              const { label, detail, parts, value } = describeAction(a)
              const destructive = a.action === 'delete_routines' || a.action === 'remove_exercises'
              const ICONS = {
                set_settings: 'gear', log_bodyweight: 'scale', set_goal: 'target',
                plan_day: 'calendar', set_week: 'calendar',
              }
              return <div key={i}>
                {detail && <div className="small dim" style={{ marginBottom: 6 }}>{t(...detail)}</div>}
                {parts?.length > 0 && <div className="small dim" style={{ marginBottom: 6 }}>{parts.map(k => t(k)).join(' · ')}</div>}
                {value && <div className="small dim" style={{ marginBottom: 6 }} dir="ltr">{value} {S.unit}</div>}
                <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                  <Button size="sm" variant={destructive ? 'plain' : 'primary'} className={destructive ? 'danger' : ''}
                    icon={destructive ? 'trash' : ICONS[a.action] || 'check'} onClick={() => apply(a, m.id)}>{t(label)}</Button>
                  {a.action === 'create_plan' && (S.routines || []).length > 0 &&
                    <Button size="sm" variant="ghost" className="dim" onClick={() => apply(a, m.id, { replace: true })}>{t('Replace my plan')}</Button>}
                </div>
              </div>
            })}
          </div>}
          {m.applied && <div className="aic-done small"><Icon name="checkCircle" /> {t('Applied')}</div>}
        </div>)}

        {busy && <div className="aic-m assistant"><div className="aic-b aic-typing"><i /><i /><i /></div></div>}
      </div>

      <div className="aic-in">
        <textarea
          className="field" rows={1} value={input} placeholder={t('Ask your AI coach…')}
          aria-label={t('Ask your AI coach…')}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
        />
        <button className="aic-send" disabled={!input.trim() || busy} onClick={() => send()} aria-label={t('Send')}>
          <Icon name={busy ? 'timer' : 'arrowUp'} />
        </button>
      </div>
    </>}
  </div>
}
