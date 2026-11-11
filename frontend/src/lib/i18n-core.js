// Runtime-agnostic core of the i18n module: state, constants and readers (t, dateLocale,
// instrFor, getLang). Plain Node-loadable — the browser-only pieces (import.meta.glob lazy
// loads, the React subscription hook) live in i18n.js and re-export from here.

export const LANGS = {
  en: 'English', de: 'Deutsch', es: 'Español', fr: 'Français', it: 'Italiano',
  pt: 'Português', pl: 'Polski', tr: 'Türkçe', ru: 'Русский', zh: '中文',
  ko: '한국어', hi: 'हिन्दी', fa: 'فارسی'
}
export const RTL_LANGS = ['fa', 'ar', 'he', 'ur']
export const INSTR_LANGS = ['en', 'es', 'fr', 'it', 'tr', 'ru', 'zh', 'hi', 'pl', 'ko', 'fa']
export const DATE_LOCALES = {
  en: 'en-GB', de: 'de-DE', es: 'es-ES', fr: 'fr-FR', it: 'it-IT', pt: 'pt-PT',
  pl: 'pl-PL', tr: 'tr-TR', ru: 'ru-RU', zh: 'zh-CN', ko: 'ko-KR', hi: 'hi-IN',
  fa: 'fa-IR-u-ca-gregory-nu-latn'
}

let lang = 'en'                 // set only by _setLangState, called from i18n.js setLang
let cal = 'jalali'              // 'jalali' | 'gregory' — only affects Persian display dates
let dict = {}                   // current locale pack (empty = English fallback)
let instr = null                // { exId: [steps] } for the current language, null = English
let exNames = null              // { exId: translatedName } for the current language, null = English
let version = 0                 // bumped on every setLang; drives the React subscription selector

export const getLang = () => lang
export const getCal = () => cal
export const dateLocale = () => {
  if (lang === 'fa' && cal === 'jalali') return 'fa-IR-u-ca-persian-nu-latn'
  return DATE_LOCALES[lang] || 'en-GB'
}
export const getVersion = () => version
export const isRTL = l => RTL_LANGS.includes(l || lang)

// Translate a source string; {0},{1}… are replaced with args (also on the English fallback).
export function t(s, ...args) {
  let v = dict[s] || s
  for (let i = 0; i < args.length; i++) v = v.replaceAll('{' + i + '}', args[i])
  return v
}

// Localised exercise name when a translation pack exists for the active language.
export const exName = ex => (ex && exNames && exNames[ex.id]) || (ex && ex.n) || ''
export const exOrigName = ex => (ex && exNames && exNames[ex.id] && exNames[ex.id] !== ex.n ? ex.n : '')

// Instructions for an exercise in the current language (English steps as fallback).
export const instrFor = ex => (instr && instr[ex.id]) || ex.st || []

export function _setCalState(nextCal) {
  const normalized = nextCal === 'gregory' ? 'gregory' : 'jalali'
  if (cal === normalized) return version
  cal = normalized
  version++
  return version
}

// Called by i18n.js's setLang once the locale pack has been loaded — kept here rather than
// exported as setLang because loading packs requires import.meta.glob, which is Vite-only.
// Both `dict` and `instr` may be null to reset to English.
export function _setLangState(newLang, newDict, newInstr, newExNames = null) {
  lang = LANGS[newLang] ? newLang : 'en'
  dict = lang === 'en' ? {} : (newDict || {})
  instr = lang === 'en' || !INSTR_LANGS.includes(lang) ? null : (newInstr || null)
  exNames = lang === 'en' ? null : (newExNames || null)
  version++
  return version
}
