import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { imgSrc, gifSrc, EXDB } from './exercises.js'

// The exercise media ships *inside* the APK. Two earlier releases got this wrong
// in opposite directions, so both directions are pinned here.
//
// 1.4.0 shipped with no .env.production at all: exercises.js fell back to its
// relative 'img/' and 'gif/' defaults, nothing was packaged, and every exercise
// rendered a broken-image placeholder. 1.4.1 fixed that by pointing the bases at
// a commit-pinned CDN -- which made the app useless without a connection, in an
// app whose entire job is showing you the movement.
//
// The fix for both is to package the media and keep the relative defaults. So:
// no env file, relative bases, and -- the assertion that actually bites -- a
// real file on disk for every entry in the dataset.
const ROOT = path.resolve(__dirname, '../..')
const PUBLIC = path.join(ROOT, 'public')

describe('exercise media configuration', () => {
  it('ships no .env.production — the media is packaged, not fetched', () => {
    // A stray env file would silently point a release back at the network.
    expect(fs.existsSync(path.join(ROOT, '.env.production'))).toBe(false)
  })

  it('resolves media relative to the bundle, with no host', () => {
    const ex = EXDB[0]
    for (const src of [imgSrc(ex), gifSrc(ex)]) {
      expect(src).not.toMatch(/^https?:\/\//)
      expect(src).not.toMatch(/^\//)
    }
  })

  it('asks for the packaged WebP, not the dataset\'s .jpg/.gif names', () => {
    const ex = EXDB[0]
    expect(ex.img).toMatch(/\.jpg$/)
    expect(ex.gif).toMatch(/\.gif$/)
    expect(imgSrc(ex)).toMatch(/\.webp$/)
    expect(gifSrc(ex)).toMatch(/\.webp$/)
    // The stem has to survive, or the rewritten name points at nothing.
    expect(imgSrc(ex)).toContain(ex.img.replace(/\.jpg$/, ''))
    expect(gifSrc(ex)).toContain(ex.gif.replace(/\.gif$/, ''))
  })

  it('every exercise in the dataset carries both media filenames', () => {
    const missing = EXDB.filter(e => !e.img || !e.gif)
    expect(missing.map(e => e.id)).toEqual([])
  })

  it('has a packaged file on disk for every exercise', () => {
    // The check 1.4.0 needed. A half-finished media conversion fails here
    // instead of shipping a build with holes in it.
    const absent = []
    for (const ex of EXDB) {
      for (const src of [imgSrc(ex), gifSrc(ex)]) {
        if (!fs.existsSync(path.join(PUBLIC, src))) absent.push(src)
      }
    }
    expect(absent.slice(0, 10)).toEqual([])
    expect(absent).toHaveLength(0)
  })

  it('keeps the packaged set small enough to install', () => {
    // WebP at 1.5x came in around 55 MB against the GIFs' 118 MB. If a future
    // re-encode blows past ~90 MB the APK stops being a reasonable download.
    let bytes = 0
    for (const sub of ['img', 'gif']) {
      const dir = path.join(PUBLIC, sub)
      if (!fs.existsSync(dir)) continue
      for (const f of fs.readdirSync(dir)) bytes += fs.statSync(path.join(dir, f)).size
    }
    expect(bytes).toBeGreaterThan(10 * 1024 * 1024)
    expect(bytes).toBeLessThan(90 * 1024 * 1024)
  })
})
