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

  it('asks for the packaged files, not the dataset\'s .jpg/.gif names', () => {
    // Stills are WebP; animations are H.264 in MP4 (see lib/exercises.js for the
    // measurements behind that choice).
    const ex = EXDB[0]
    expect(ex.img).toMatch(/\.jpg$/)
    expect(ex.gif).toMatch(/\.gif$/)
    expect(imgSrc(ex)).toMatch(/\.webp$/)
    expect(gifSrc(ex)).toMatch(/\.mp4$/)
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
    // H.264 at 3x came in around 57 MB, against 65 MB for the animated WebP at 1.5x it
    // replaced -- three times the resolution for slightly less space. If a future
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

  // The bug this pins is the one that shipped in version 1: the animations were encoded
  // at 270x270 but .exmedia paints them into a 380px-tall box, so the WebView upscaled
  // every frame on top of a 180x180 source. Encoding at or above the paint size means the
  // browser is always downscaling, which is the direction that hides interpolation.
  it('encodes the animation at least as large as the box it is painted into', () => {
    const CSS_BOX = 380   // .exmedia video height on a phone, src/index.css
    const mp4 = fs.readFileSync(path.join(PUBLIC, gifSrc(EXDB[0])))
    // Dimensions live in the avc1 sample entry inside stsd. From the start of the 'avc1'
    // type: 4 bytes to the box body, 8 bytes of SampleEntry (6 reserved + data ref index),
    // 16 bytes of VisualSampleEntry preamble, then 16-bit width and height. Searching from
    // stsd rather than byte 0 avoids matching the string in ftyp's compatible-brands list.
    const stsd = mp4.indexOf(Buffer.from('stsd'))
    expect(stsd, 'no stsd box — not an MP4?').toBeGreaterThan(0)
    const at = mp4.indexOf(Buffer.from('avc1'), stsd)
    expect(at, 'no avc1 sample entry — not an H.264 track?').toBeGreaterThan(0)
    const width = mp4.readUInt16BE(at + 28)
    const height = mp4.readUInt16BE(at + 30)
    expect(width).toBeGreaterThanOrEqual(CSS_BOX)
    expect(height).toBeGreaterThanOrEqual(CSS_BOX)
  })

  it('encodes every animation as playable H.264, not a renamed GIF', () => {
    // A partial conversion that left GIF bytes under an .mp4 name would render nothing
    // at all, and the file-exists check above would not notice.
    let checked = 0
    for (const ex of EXDB.slice(0, 60)) {
      const buf = fs.readFileSync(path.join(PUBLIC, gifSrc(ex)))
      expect(buf.subarray(4, 8).toString(), gifSrc(ex)).toBe('ftyp')
      const s = buf.indexOf(Buffer.from('stsd'))
      expect(buf.indexOf(Buffer.from('avc1'), s), gifSrc(ex)).toBeGreaterThan(0)
      checked++
    }
    expect(checked).toBe(60)
  })
})
