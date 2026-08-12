// AI coach credentials, deliberately kept OUT of the synced state object.
//
// S is pushed to the server (self-hosted build) and written into backup JSON that people share
// when they report a bug — an API key must not travel in either. This module keeps the config
// in localStorage on the device only, with the same useSyncExternalStore pattern as i18n so
// both the coach screen and Settings re-render when it changes.

import { useSyncExternalStore } from 'react'

const KEY = 'gym_ai_cfg_v1'
const DEF = { base: '', key: '', model: '', autoTranslate: false }

let cfg = (() => {
  try { return Object.assign({}, DEF, JSON.parse(localStorage.getItem(KEY)) || {}) }
  catch { return { ...DEF } }
})()

let version = 0
const subs = new Set()

export const getAi = () => cfg
export const aiReady = (c = cfg) => !!(c.base && c.key && c.model)

export function setAi(patch) {
  cfg = { ...cfg, ...patch }
  try { localStorage.setItem(KEY, JSON.stringify(cfg)) } catch { /* private mode */ }
  version++
  subs.forEach(fn => fn())
}

export function clearAi() {
  cfg = { ...DEF }
  try { localStorage.removeItem(KEY) } catch { /* ignore */ }
  version++
  subs.forEach(fn => fn())
}

export function useAi() {
  useSyncExternalStore(fn => { subs.add(fn); return () => subs.delete(fn) }, () => version)
  return cfg
}
