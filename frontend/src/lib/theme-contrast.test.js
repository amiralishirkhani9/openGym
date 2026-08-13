// Theme contrast, computed from index.css rather than eyeballed.
//
// The segmented control was retinted to carry the accent, like every other "on" surface in
// the app. That change is only safe if the label on the pill stays legible across all eight
// accents in both themes, and the pill stays visible AS a shape against its own track. Both
// are arithmetic, so both are checked here instead of in a screenshot.
//
// The bars come from WCAG 2.1:
//   1.4.3  text contrast. Segmented labels are 14px/600 — NOT "large text" (that starts at
//          18.66px, or 14px at bold/700), so the bar is 4.5:1, not 3:1. This is the trap the
//          previous --on-acc token fell into: it was chosen for 17px/600 buttons at the 3:1
//          bar and is white for half the accents, which does not survive at 14px.
//   1.4.11 non-text contrast. The selected pill is a state indicator, so its boundary needs
//          3:1 against the adjacent colour — satisfiable by the fill or by a border.

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const CSS = fs.readFileSync(path.resolve(__dirname, '../index.css'), 'utf8')

// ---- colour maths -------------------------------------------------------------------

const rgb = h => {
  const s = h.replace('#', '')
  const full = s.length === 3 ? [...s].map(c => c + c).join('') : s
  return [0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16))
}

const lum = h => {
  const [r, g, b] = rgb(h).map(c => {
    const x = c / 255
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}

// rgba(...) over an opaque backdrop — the light theme's track is a translucent grey.
const flatten = (spec, backdrop) => {
  const m = spec.match(/rgba?\(([^)]+)\)/)
  if (!m) return spec
  const [r, g, b, a = '1'] = m[1].split(',').map(s => s.trim())
  const bg = rgb(backdrop)
  const out = [r, g, b].map((c, i) => Math.round(Number(c) * Number(a) + bg[i] * (1 - Number(a))))
  return '#' + out.map(c => c.toString(16).padStart(2, '0')).join('')
}

// ---- read the tokens out of the stylesheet ------------------------------------------

// The :root block, and the [data-theme="light"] override block.
const block = selector => {
  const at = CSS.indexOf(selector)
  expect(at, `${selector} not found in index.css`).toBeGreaterThan(-1)
  const open = CSS.indexOf('{', at)
  return CSS.slice(open, CSS.indexOf('\n}', open))
}

const ROOT = block(':root {')
const LIGHT = block(':root[data-theme="light"] {')

const token = (name, src) => {
  const m = src.match(new RegExp(`--${name}\\s*:\\s*([^;]+);`))
  return m ? m[1].trim() : null
}

// Accents are declared as :root[data-accent="x"] { --acc:var(--green); --acc-2:#... }
const accents = () => {
  const out = {}
  const re = /:root\[data-accent="(\w+)"\]\s*\{([^}]+)\}/g
  let m
  while ((m = re.exec(CSS)) !== null) {
    const [, name, body] = m
    const acc = body.match(/--acc\s*:\s*([^;]+);/)?.[1].trim()
    const acc2 = body.match(/--acc-2\s*:\s*([^;]+);/)?.[1].trim()
    out[name] = { acc, acc2 }
  }
  return out
}

// var(--green) -> the literal, per theme. The system palette is declared in both blocks.
const resolve = (value, theme) => {
  if (!value) return null
  const m = value.match(/var\(--([\w-]+)\)/)
  if (!m) return value
  const src = theme === 'light' ? LIGHT : ROOT
  return token(m[1], src) || token(m[1], ROOT)
}

const ACCENTS = accents()
const NAMES = Object.keys(ACCENTS)

describe('theme tokens', () => {
  it('declares every accent the settings screen offers', () => {
    // ACCENTS in the JS and the CSS blocks have to agree, or picking a swatch sets an
    // attribute no rule matches and the accent silently stays green.
    expect(NAMES.length).toBeGreaterThanOrEqual(8)
    for (const n of NAMES) {
      expect(ACCENTS[n].acc, `--acc missing for ${n}`).toBeTruthy()
      expect(ACCENTS[n].acc2, `--acc-2 missing for ${n}`).toBeTruthy()
    }
  })

  it('gives the segmented control its own label colour, not the button one', () => {
    // Reusing --on-acc here is the bug this token exists to prevent: it is white for sky,
    // violet, pink and red, and white on those at 14px fails 4.5:1.
    expect(token('on-seg', ROOT)).toBeTruthy()
    expect(token('seg-pill', ROOT)).toContain('--acc')
    expect(token('seg-ring', ROOT)).toContain('--acc-2')
  })

  it('does not override the pill colour in light mode', () => {
    // The point of the change is that the control looks like the rest of the app in BOTH
    // themes. A light-mode override back to white would undo it for half the users.
    expect(token('seg-pill', LIGHT)).toBeNull()
  })
})

describe('segmented control contrast', () => {
  const onSeg = '#000000'   // --on-seg

  for (const theme of ['dark', 'light']) {
    const trackRaw = token('seg-track', theme === 'light' ? LIGHT : ROOT)
    const card = theme === 'light' ? '#ffffff' : '#1c1c1e'
    const track = flatten(trackRaw, card)

    for (const name of NAMES) {
      const pill = resolve(ACCENTS[name].acc, theme)
      const ring = resolve(ACCENTS[name].acc2, theme)

      it(`${name}/${theme}: the selected label passes 4.5:1 on the pill`, () => {
        expect(ratio(onSeg, pill), `${onSeg} on ${pill}`).toBeGreaterThanOrEqual(4.5)
      })

      it(`${name}/${theme}: the pill's boundary passes 3:1 against its track`, () => {
        // Either the fill or the ring may carry it — WCAG 1.4.11 permits a border to
        // provide the boundary. They fail in opposite themes, which is why both are drawn.
        const best = Math.max(ratio(pill, track), ratio(ring, track))
        expect(best, `fill ${pill} / ring ${ring} vs track ${track}`).toBeGreaterThanOrEqual(3)
      })
    }
  }

  it('the unselected label passes 4.5:1 on the track', () => {
    // This was failing before the retint and is unrelated to it: the control used --label-2
    // (60% opacity), which reaches 5.61:1 over the dark track but only 3.24:1 over the light
    // one. The recessed track is LIGHTER than the card it sits in, so a secondary label that
    // passes everywhere else does not pass here. --seg-label exists for that.
    for (const theme of ['dark', 'light']) {
      const src = theme === 'light' ? LIGHT : ROOT
      const card = theme === 'light' ? '#ffffff' : '#1c1c1e'
      const track = flatten(token('seg-track', src), card)
      const label = flatten(token('seg-label', src), track)
      expect(ratio(label, track), `${theme}: ${label} on ${track}`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('keeps the unselected label visibly secondary rather than just legible', () => {
    // Fixing the ratio by making it full-strength white/black would erase the difference
    // between chosen and unchosen for everyone. It has to stay dimmer than --label.
    for (const theme of ['dark', 'light']) {
      const src = theme === 'light' ? LIGHT : ROOT
      const alpha = Number(token('seg-label', src).match(/,\s*\.?(\d+)\)/)[0].match(/[\d.]+/)[0])
      expect(alpha).toBeLessThan(1)
      expect(alpha).toBeGreaterThan(0.5)
    }
  })
})

describe('the control is still distinguishable without colour', () => {
  it('carries the selection in font weight as well as in hue', () => {
    // Two of the accents (lime, gold) are yellow-green; a red-green colour-blind user
    // separates selected from unselected by weight, not hue.
    const seg = CSS.slice(CSS.indexOf('.seg button:not(.on)'))
    expect(seg).toMatch(/\.seg button:not\(\.on\)\{[^}]*font-weight:400/)
    expect(seg).toMatch(/\.seg button\.on\{[^}]*font-weight:600/)
  })
})
