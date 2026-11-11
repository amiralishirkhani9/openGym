import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { exOr, isAssistedEq, isStretch, isMachineCardio } from '../lib/exercises.js'
import { effectiveRoutine, lastEntryFor, bestWeightFor, buildSets, freestyleConfig, defaultConfig, setsDoneActive, supersetUnits, unitOf, setLabel, modeOf, isBw, isPerSide, sideReps, repStep, EFFORT, effortOf, stepEffort, capEffort, cascadeWeight, insertWarmupRow, removeRowAt } from '../lib/history.js'
import { fmtNum, fmtDate, todayISO, exCount, DAYN } from '../lib/format.js'
import { beep, vibrate } from '../lib/sound.js'
import { t, exName, exOrigName } from '../lib/i18n.js'
import Media from '../components/Media.jsx'
import { startFlow, exercisePicker, exConfigSheet, exerciseDetailSheet, topWeightSheet, finishWorkout, workoutCompleteSheet, confirmSheet } from '../sheets.jsx'
import Icon from '../components/Icon.jsx'
import { Button, Check, NumberField } from '../components/ui.jsx'
import { nextPrescription, applyPrescription } from '../lib/progression.js'
import { glyphOf } from '../lib/glyphs.js'

/* ---------- start chooser (no active workout) ---------- */
function StartChooser() {
  const nav = useNavigate()
  const S = useStore(s => s.S)
  const todayR = effectiveRoutine(S, todayISO())
  const todayOvr = S.dayPlan[todayISO()] !== undefined
  const others = S.routines.filter(r => r !== todayR)
  return <div className="narrow">
    <div className="hdr"><div><h1>{t('Start workout')}</h1><div className="sub">{t(DAYN[new Date().getDay()])} — {todayR ? t('today is {0}', todayR.name) : t('rest day, but no one’s stopping you')}</div></div></div>
    {todayR && <div className="card" style={{ borderColor: 'var(--acc)' }}>
      <h2 className="accent">{t("Today's plan")}{todayOvr ? ' · ' + t('rescheduled') : ''}</h2>
      <div className="row between" style={{ marginBottom: 12 }}>
        <div><div className="big">{todayR.name}</div><div className="muted small">{exCount(todayR.ex.length)}</div></div>
        <span className="lrow-i" style={{ width: 38, height: 38, borderRadius: 9, fontSize: 22 }}><Icon name={glyphOf(todayR.emoji)} /></span>
      </div>
      <Button variant="primary" icon="play" onClick={() => startFlow(todayR.id)}>{t('Start {0}', todayR.name)}</Button>
    </div>}
    {others.length > 0 && <><h4 className="sec">{t('Other routines')}</h4>
      <div className="list">{others.map(r => <div key={r.id} className="item" onClick={() => startFlow(r.id)}>
        <span className="lrow-i"><Icon name={glyphOf(r.emoji)} /></span>
        <div className="grow"><div className="tt">{r.name}</div><div className="ss">{exCount(r.ex.length)}</div></div>
        <span className="tag acc">{t('Start')}</span></div>)}</div></>}
    <div style={{ height: 14 }} />
    <Button icon="shuffle" onClick={() => startFlow(null)}>{t('Freestyle workout (pick as you go)')}</Button>
    {!S.routines.length && <><div style={{ height: 10 }} /><Button variant="primary" onClick={() => nav('/plan')}>{t('Build a plan first')}</Button></>}
  </div>
}

/* ---------- elapsed clock (isolated so the workout tree doesn't re-render every second) ---------- */
function Elapsed({ start }) {
  const [txt, setTxt] = useState('0:00')
  useEffect(() => {
    const tick = () => { const s = Math.floor((Date.now() - start) / 1000); setTxt(Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0')) }
    tick(); const iv = setInterval(tick, 1000); return () => clearInterval(iv)
  }, [start])
  return <span dir="ltr" className="bidi-ltr">{txt}</span>
}

/* ---------- one exercise block (reps: weight×reps · time: a held duration · cardio: duration+speed) ---------- */
function ExerciseBlock({ entryIdx, compact, onToggle, onField, onAddSet, onRemoveSet, onAddWarmup, onRemoveSetAt, onStartTimed, onConfigure, onAddBeltWeight }) {
  const S = useStore(s => s.S)
  const working = useUI(s => s.work)
  const entry = S.active.entries[entryIdx]
  const ex = exOr(entry.id)
  const cfg = { ...(entry.target || {}), id: entry.id }
  const mode = modeOf(cfg)
  const cardio = mode === 'cardio'
  const timed = mode === 'time'
  const stretch = isStretch(ex)
  const assisted = isAssistedEq(ex)
  const machineCardio = cardio && (isMachineCardio(ex) || entry.sets.some(s => (s.speed || 0) > 0))
  const last = lastEntryFor(S, entry.id)
  const best = cardio ? 0 : Math.max(bestWeightFor(S, entry.id), (S.exWeights[entry.id] || {}).w || 0)
  const plan = entry.plan
  const bw = !cardio && isBw(cfg)
  const added = bw && entry.sets.some(s => (s.w || 0) > 0)
  const loadHd = assisted ? t('Assist ({0})', S.unit) : bw ? t('Added ({0})', S.unit) : t('Weight ({0})', S.unit)
  const loadCol = { f: 'w', step: 2.5, dec: true, hd: loadHd }
  const repCol = { f: 'r', step: repStep(cfg), dec: false, hd: t('Reps') }
  const col1 = cardio ? { f: 'min', step: 1, dec: false, hd: t('Duration (min)') }
    : timed ? { f: 'sec', step: 5, dec: false, hd: t('Seconds') }
      : (bw && !added) ? repCol : loadCol
  const col2 = cardio ? (machineCardio ? { f: 'speed', step: 0.5, dec: true, hd: t('Speed (km/h)') } : null)
    : timed ? ((bw && !added) ? null : loadCol)
      : (bw && !added) ? null : repCol
  const kind = effortOf(S)
  const eff = EFFORT[kind]
  const col3 = mode === 'reps' && eff ? { ...eff, eff: kind, dec: true, opt: true, hd: t(eff.hd) } : null
  const bump = (s, i, col, dir) => {
    if (col.eff) return onField(i, col.f, stepEffort(col.eff, s[col.f], dir))
    onField(i, col.f, Math.max(0, Math.round(((s[col.f] || 0) + dir * col.step) * 100) / 100))
  }
  const cell = (s, i, col, cls) => (
    <div className={'stp ' + cls}>
      <button aria-label="Decrease" onClick={() => bump(s, i, col, -1)}><Icon name="minus" /></button>
      <span className="val"><NumberField decimal={col.dec} nullable={col.opt} value={s[col.f] ?? ''}
        onChange={v => onField(i, col.f, col.eff ? capEffort(col.eff, v) : v)} /></span>
      <button aria-label="Increase" onClick={() => bump(s, i, col, 1)}><Icon name="plus" /></button>
    </div>
  )
  const title = exName(ex)
  const subTitle = exOrigName(ex)
  const singleBout = (cardio || (timed && stretch)) && entry.sets.length === 1 && !entry.sets[0]?.warmup
  return <>
    <Media ex={ex} key={entry.id} compact={compact} minimizable />
    <div className="row between" style={{ marginBottom: 6, alignItems: 'flex-start' }}>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: compact ? 17 : 20, fontWeight: 600, letterSpacing: '-.02em', textTransform: 'capitalize', lineHeight: 1.25 }}>{title}</div>
        {subTitle && <div className="dim small capitalize" dir="ltr" style={{ marginTop: 2, textAlign: 'start' }}>{subTitle}</div>}
      </div>
      <div className="row" style={{ gap: 6, flex: 'none' }}>
        <button className="iconbtn" aria-label={t('Configure exercise')} onClick={onConfigure}><Icon name="wrench" /></button>
        <button className="iconbtn" aria-label={t('Details')} onClick={() => exerciseDetailSheet(ex)}><Icon name="info" /></button>
      </div>
    </div>
    <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
      {cardio && <span className="tag acc"><Icon name="figureRun" />{t('Cardio')}</span>}
      {timed && stretch && <span className="tag acc"><Icon name="stretch" />{t('Stretch')}</span>}
      {!cardio && !timed && isPerSide(cfg) && <span className="tag acc nocap"><Icon name="shuffle" />{t('{0} per side', fmtNum(sideReps(entry.sets.find(s => !s.done)?.r ?? entry.sets[0]?.r)))}</span>}
      {(ex.tg || ex.bp) && <span className="tag">{t(ex.tg || ex.bp)}</span>}
      {ex.eq && <span className="tag">{t(ex.eq)}</span>}
      {best > 0 && <span className="tag nocap">{t('Best:')} <span dir="ltr" className="bidi-ltr">{fmtNum(best)} {S.unit}</span></span>}
    </div>
    {last && <div className="small dim" style={{ marginBottom: 4 }}>{t('Last time')} ({fmtDate(last.d)}): <span dir="ltr" className="bidi-ltr">{last.sets.map(s => setLabel(entry.id, s, last.target)).join(', ')}</span></div>}
    {plan && plan.why && plan.kind !== 'off' && <div className={'progline' + (plan.kind === 'deload' ? ' warn' : '')}>
      <Icon name={plan.kind === 'up' ? 'arrowUp' : plan.kind === 'deload' ? 'arrowDown' : 'lightbulb'} />
      <span>{t(...plan.why)}</span>
    </div>}
    <div className="card" style={{ marginTop: 10, marginBottom: 0 }}>
      <div className={'sethead' + (col3 ? ' eff3' : '')}><span className="n-sp" /><span className="w-sp">{col1.hd}</span>{col2 && <span className="r-sp">{col2.hd}</span>}{col3 && <span className="eff-sp">{col3.hd}</span>}{timed && <span className="ck-sp" />}<span className="ck-sp" /></div>
      {entry.sets.map((s, i) => {
        const warmBefore = i > 0 && !!entry.sets[i - 1].warmup
        const isFirstWarmup = !!s.warmup && !warmBefore
        const phaseNum = entry.sets.slice(0, i + 1).filter(x => (x.warmup === true) === (s.warmup === true)).length
        return <div key={i}>
          {isFirstWarmup && <div className="setph">{t('Warm-up')}</div>}
          {!s.warmup && warmBefore && <div className="setsep" />}
          <div className={'setrow' + (s.done ? ' done' : '') + (col3 ? ' eff3' : '')}>
            <div className="n">{phaseNum}</div>
            {cell(s, i, col1, 'w')}
            {col2 && cell(s, i, col2, 'r')}
            {col3 && cell(s, i, col3, 'eff')}
            {timed && <button className="setgo" aria-label={t('Start set')} disabled={s.done || !!working}
              onClick={() => onStartTimed(i)}><Icon name="play" /></button>}
            {s.warmup && <button className="iconbtn" style={{ fontSize: 13 }} aria-label={t('Remove set')}
              disabled={entry.sets.length <= 1} onClick={() => onRemoveSetAt(i)}><Icon name="xmark" /></button>}
            <Check checked={s.done} onChange={() => onToggle(i)} />
          </div>
        </div>
      })}
      <div style={{ height: 8 }} />
      <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
        {!singleBout && <Button size="sm" icon="flame" onClick={onAddWarmup}>{t('Add warm-up set')}</Button>}
        {entry.sets.length > 1 && <Button size="sm" icon="minus" onClick={onRemoveSet}>{t('Remove set')}</Button>}
        <Button size="sm" icon="plus" onClick={onAddSet}>{singleBout ? t('Add round') : t('Add set')}</Button>
        {bw && !added && !stretch && <Button size="sm" icon="dumbbell" onClick={onAddBeltWeight}>{t('Add weight')}</Button>}
      </div>
    </div>
  </>
}

/* ---------- active workout ---------- */
function ActiveWorkout() {
  const nav = useNavigate()
  const S = useStore(s => s.S)
  const update = useStore(s => s.update)
  const { startRest, stopRest } = useUI()
  const A = S.active
  const units = supersetUnits(A.entries)
  const cur = Math.min(A.cur, Math.max(0, A.entries.length - 1))
  const unit = A.entries.length ? unitOf(units, cur) : []
  const unitIdx = units.findIndex(u => u === unit)
  const isSuperset = unit.length > 1

  const total = A.entries.reduce((n, e) => n + e.sets.length, 0)
  const done = setsDoneActive(A)

  const mutEntry = (idx, fn) => update(s => { fn(s.active.entries[idx]) }, true)
  // Clearing an optional field drops the key rather than storing null, so a set only carries
  // what was actually logged — in the session, in history and in a backup.
  const setField = (idx, i, field, v) => mutEntry(idx, e => {
    if (v == null) delete e.sets[i][field]; else e.sets[i][field] = v
    // Changing a weight cascades to the following sets of the same phase, so a
    // heavier bar carries through the set instead of retyping every row.
    if (field === 'w') {
      e.sets = cascadeWeight(e.sets, i, v)
    }
  })
  const modeAt = idx => modeOf({ ...(A.entries[idx].target || {}), id: A.entries[idx].id })
  const addSet = idx => mutEntry(idx, e => {
    const l = e.sets[e.sets.length - 1]
    const m = modeOf({ ...(e.target || {}), id: e.id })
    if (m === 'cardio') e.sets.push({ min: l ? l.min : (e.target.min || 20), speed: l ? l.speed : (e.target.speed || 8), done: false })
    else if (m === 'time') e.sets.push({ sec: l ? l.sec : (e.target.sec || 45), w: l ? (l.w || 0) : (e.target.weight || 0), done: false })
    else e.sets.push({ w: l ? l.w : 0, r: l ? l.r : e.target.reps, done: false })
  })
  const removeSet = idx => mutEntry(idx, e => { if (e.sets.length > 1) e.sets.pop() })
  const addWarmup = idx => mutEntry(idx, e => {
    const m = modeOf({ ...(e.target || {}), id: e.id })
    e.sets = insertWarmupRow(e.sets, m, e.target || {})
  })
  const removeSetAt = (idx, i) => mutEntry(idx, e => { e.sets = removeRowAt(e.sets, i) })
  const addBeltWeight = idx => mutEntry(idx, e => {
    e.target = { ...(e.target || {}), bodyweight: true }
    e.sets.forEach(s => { if (!s.done && !(s.w > 0)) s.w = 2.5 })
  })
  const configureEntry = idx => {
    const e = A.entries[idx]
    const ex = exOr(e.id)
    exConfigSheet(ex, { ...(e.target || {}), sets: e.sets.length }, cfg => {
      update(s => {
        const entry = s.active.entries[idx]
        if (!entry) return
        entry.target = { ...cfg }
        const doneRows = entry.sets.filter(x => x.done)
        const need = Math.max(doneRows.length, cfg.sets || 1)
        const fresh = buildSets(s, { ...cfg, id: entry.id, sets: need })
        entry.sets = [...doneRows, ...fresh.slice(doneRows.length)]
        if (!entry.sets.length) entry.sets = fresh
      })
    }, A.entries.length > 1 ? () => {
      update(s => {
        s.active.entries.splice(idx, 1)
        s.active.cur = Math.min(s.active.cur, Math.max(0, s.active.entries.length - 1))
      })
    } : null, S.routines.find(r => r.id === A.routineId))
  }

  // A timed set is held, not typed. The work timer records what was actually held — an early
  // finish logs 0:38 of a 0:45 target rather than crediting the full prescription — and then
  // checks the set off through the normal path, so rest, supersets and the finish prompt all
  // behave exactly as they do for a reps set.
  const startTimed = (idx, i) => {
    const e = A.entries[idx]
    useUI.getState().startWork(e.sets[i].sec || 45, exName(exOr(e.id)), elapsed => {
      mutEntry(idx, en => { en.sets[i].sec = elapsed })
      if (!useStore.getState().S.active.entries[idx].sets[i].done) toggle(idx, i)
    })
  }

  const toggle = (idx, i) => {
    const m = modeAt(idx)
    const cardioEntry = m === 'cardio'
    const isLastUnit = unitIdx >= units.length - 1
    let askTop = false, exJustDone = false, workoutDone = false
    mutEntry(idx, e => {
      e.sets[i].done = !e.sets[i].done
      if (e.sets[i].done) {
        beep(S.sound, 1040, 0.12); vibrate(30)
        const isLastExInUnit = idx === unit[unit.length - 1]
        const unitDone = unit.every(ui => (ui === idx ? e : A.entries[ui]).sets.every(x => x.done))
        if (isLastExInUnit && !unitDone) startRest(S.restSec)
        else if (unitDone) stopRest()
        if (unitDone && isLastUnit) workoutDone = true      // last exercise's last set → done
        // Only loaded reps training has a "working weight" worth confirming — a bodyweight
        // plank has nothing to put in that slider, and neither does a set of push-ups
        // (issue #32: the fewest taps that still record what happened).
        const loaded = m === 'reps' && !(isBw({ ...(e.target || {}), id: e.id }) && !e.sets.some(x => x.w > 0))
        if (e.sets.every(x => x.done)) { exJustDone = true; if (loaded && !e.asked) { e.asked = true; askTop = true } }
      }
    })
    // reps: topWeight first (it chains into the finish/continue prompt on the last unit).
    // cardio/timed or already-confirmed: go straight to the prompt.
    if (askTop) topWeightSheet(idx)
    else if (workoutDone) workoutCompleteSheet()
    else if (exJustDone && cardioEntry) useUI.getState().toast(t('Cardio logged'))
    else if (exJustDone && m === 'time') useUI.getState().toast(t('Hold logged'))
  }


  return <div className="narrow">
    <div className="hdr">
      <button className="iconbtn" aria-label={t('Discard')} onClick={() => confirmSheet({ title: t('Discard workout?'), message: t('The sets you logged in this session will be lost.'), confirmText: t('Discard'), danger: true, onConfirm: () => { update(s => { s.active = null }); stopRest(); nav('/home') } })}><Icon name="xmark" /></button>
      <div style={{ textAlign: 'center', minWidth: 0, flex: 1 }}>
        <div style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{A.name}</div>
        <div className="sub"><Elapsed start={A.start} /> · {t('{0} sets', done + '/' + total)}</div>
      </div>
      <div className="row" style={{ gap: 6, flex: 'none' }}>
        <button className="iconbtn" aria-label={t('Rest timer')} title={t('Rest timer')} onClick={() => startRest(S.restSec)}><Icon name="timer" /></button>
        <button className="iconbtn" style={{ color: 'var(--acc)' }} aria-label={t('Finish')} onClick={finishWorkout}><Icon name="check" /></button>
      </div>
    </div>
    <div className="wprog"><i style={{ width: (total ? done / total * 100 : 0) + '%' }} /></div>

    {units.length > 1 && (
      <div className="ex-pills">
        {units.map((u, ui) => {
          const active = ui === unitIdx
          const uDone = u.every(idx => A.entries[idx]?.sets.every(s => s.done))
          const label = u.map(idx => exName(exOr(A.entries[idx].id))).join(' + ')
          return (
            <button key={ui} className={'ex-pill' + (active ? ' on' : '') + (uDone ? ' done' : '')}
              onClick={() => update(s => { s.active.cur = u[0] })}>
              {uDone ? <Icon name="check" /> : <span>{ui + 1}</span>}
              <span className="ex-pill-t">{label}</span>
            </button>
          )
        })}
      </div>
    )}

    {A.entries.length ? <>
      <div className="muted small" style={{ marginBottom: 6 }}>{isSuperset ? t('Superset {0} / {1}', unitIdx + 1, units.length) : t('Exercise {0} / {1}', unitIdx + 1, units.length)}</div>
      {isSuperset ? (
        <div className="ss-card">
          <div className="ss-hd"><Icon name="link" />{t('Superset · do these back-to-back, rest after both')}</div>
          {unit.map((idx, k) => <div key={idx} className="ss-ex">
            {k > 0 && <div className="ss-amp">+</div>}
            <ExerciseBlock entryIdx={idx} compact
              onToggle={i => toggle(idx, i)} onField={(i, f, v) => setField(idx, i, f, v)} onAddSet={() => addSet(idx)} onRemoveSet={() => removeSet(idx)} onAddWarmup={() => addWarmup(idx)} onRemoveSetAt={i => removeSetAt(idx, i)} onStartTimed={i => startTimed(idx, i)} onConfigure={() => configureEntry(idx)} onAddBeltWeight={() => addBeltWeight(idx)} />
          </div>)}
        </div>
      ) : (
        <ExerciseBlock entryIdx={cur} onToggle={i => toggle(cur, i)} onField={(i, f, v) => setField(cur, i, f, v)} onAddSet={() => addSet(cur)} onRemoveSet={() => removeSet(cur)} onAddWarmup={() => addWarmup(cur)} onRemoveSetAt={i => removeSetAt(cur, i)} onStartTimed={i => startTimed(cur, i)} onConfigure={() => configureEntry(cur)} onAddBeltWeight={() => addBeltWeight(cur)} />
      )}
    </> : <div className="empty"><div className="ico"><Icon name="shuffle" /></div>{t('Freestyle workout — add your first exercise.')}</div>}

    <div style={{ height: 12 }} />
    <div className="row">
      <Button icon="chevronLeft" className="nav-prev" disabled={unitIdx <= 0} onClick={() => update(s => { s.active.cur = units[unitIdx - 1][0] })}>{t('Prev')}</Button>
      <Button trailingIcon="chevronRight" className="nav-next" disabled={unitIdx < 0 || unitIdx >= units.length - 1} onClick={() => update(s => { s.active.cur = units[unitIdx + 1][0] })}>{t('Next')}</Button>
    </div>
    <div style={{ height: 10 }} />
    <Button onClick={() => exercisePicker(ex => {
      const routine = S.routines.find(r => r.id === A.routineId)
      const freestyle = !A.routineId
      // Freestyle has no routine prescription to apply: show the last target in the config
      // sheet and carry its completed rows forward. A planned session keeps its existing path.
      const seed = freestyle ? freestyleConfig(S, { id: ex.id, ...defaultConfig(ex.id) }) : null
      exConfigSheet(ex, null, cfg => update(s => {
        const full = { ...cfg, id: ex.id }
        const plan = freestyle ? null : nextPrescription(s, full, s.routines.find(r => r.id === s.active.routineId))
        const sets = buildSets(s, full, freestyle ? { preferLast: true } : undefined)
        s.active.entries.push({ id: ex.id, target: { ...cfg }, plan, sets: freestyle ? sets : applyPrescription(sets, plan) })
        s.active.cur = s.active.entries.length - 1
      }), null, routine, seed)
    })} icon="plus">{t('Add exercise')}</Button>
    <div style={{ height: 10 }} />
    {(() => {
      const exDone = A.entries.filter(e => e.sets.length && e.sets.every(s => s.done)).length
      const allDone = A.entries.length > 0 && exDone === A.entries.length
      return <button className={allDone ? 'btn primary' : 'btn ghost dim'} onClick={finishWorkout}>
        {allDone ? t('Finish workout') : t('Finish workout early · {0} exercises', exDone + '/' + A.entries.length)}
      </button>
    })()}
    <div style={{ height: 40 }} />
  </div>
}

export default function Workout() {
  const active = useStore(s => s.S.active)
  return active ? <ActiveWorkout /> : <StartChooser />
}
