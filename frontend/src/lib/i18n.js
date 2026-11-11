// Browser-only shell of the i18n module. The runtime-agnostic state and readers live
// in i18n-core.js (plain Node-loadable); this file adds the two pieces that genuinely need
// the browser: `setLang` (which lazy-loads locale packs via import.meta.glob) and the React
// subscription hook `useLang`.

import { useSyncExternalStore } from 'react'
import {
  LANGS, INSTR_LANGS, DATE_LOCALES, RTL_LANGS,
  getLang, getCal, dateLocale, t, exName, exOrigName, instrFor, getVersion, isRTL,
  _setLangState, _setCalState
} from './i18n-core.js'

export { LANGS, INSTR_LANGS, DATE_LOCALES, RTL_LANGS, getLang, getCal, dateLocale, t, exName, exOrigName, instrFor, isRTL }

// Vite code-splits each locale pack into its own chunk via import.meta.glob; instructions use
// the same mechanism in src/instr/. Both are lazy, so the production bundle ships English only.
const localePacks = import.meta.glob('../locales/*.js')
const exNamePacks = import.meta.glob('../locales/ex/*.js')
const instrPacks = import.meta.glob('../instr/*.js')

// React subscription bookkeeping — kept here, not in core, so core has zero React coupling.
const subs = new Set()
const notify = () => { subs.forEach(f => f()) }

export function setCal(c) {
  _setCalState(c)
  notify()
}

export async function setLang(l) {
  if (!LANGS[l]) l = 'en'
  if (l === getLang() && getVersion() > 0) return
  let dict = {}, instr = null, exNames = null
  try {
    dict = l === 'en' ? {} : (await localePacks['../locales/' + l + '.js']()).default
    instr = l === 'en' || !INSTR_LANGS.includes(l) ? null : (await instrPacks['../instr/' + l + '.js']()).default
    const exLoader = exNamePacks['../locales/ex/' + l + '.js']
    if (exLoader) exNames = (await exLoader()).default
  } catch (e) { dict = {}; instr = null; exNames = null }
  _setLangState(l, dict, instr, exNames)
  notify()
}

// Re-renders the subscribing component (and its children) whenever the language changes.
export function useLang() {
  return useSyncExternalStore(fn => { subs.add(fn); return () => subs.delete(fn) }, getVersion)
}
