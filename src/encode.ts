// SPDX-License-Identifier: Apache-2.0
// glyphcast encoder: ImageData -> one HTML string per character row, with
// same-color cells merged into single spans (run-length in the DOM).
// Modes: quadrant (2x2 subpixels per char via U+2596 block family, luma-
// threshold fg/bg split), halfblock (U+2580, fg=top / bg=bottom, 2 px/char),
// ascii (luma-ramp glyph, fg color only). Also owns the unsharp-mask
// prefilter since it exists purely to feed the encoders.
// Separate from render.ts so future wire-format work (delta frames, RLE
// packets) lands here without touching DOM code.
// Test strategy: deterministic - feed a known ImageData, assert run merging.

export type Mode = 'quadrant' | 'sextant' | 'octant' | 'halfblock' | 'ascii'

// subpixel sampling factors per mode: sample image is cols*sx wide, rows*sy tall
export const sampleX = (m: Mode) => (m === 'ascii' || m === 'halfblock' ? 1 : 2)
export const sampleY = (m: Mode) => (m === 'octant' ? 4 : m === 'sextant' ? 3 : 2)
export type Frame = { rows: string[]; spans: number; htmlBytes: number }

// structural pixel source: a browser ImageData satisfies this, but so does a
// plain { data, width, height } - so encodeCells/frameToPlainText run headless
// (Bun, Node, a worker) with no DOM dependency.
export type PixelSource = { readonly data: Uint8ClampedArray; readonly width: number; readonly height: number }

import { OCT_CHARS } from './octants'

const HB = '▀'
const RAMP = ' .:-=+*#%@'
const QUAD = [' ', '▘', '▝', '▀', '▖', '▌', '▞', '▛', '▗', '▚', '▐', '▜', '▄', '▙', '▟', '█']

// sextants: 2x3 subpixels per char, Unicode 13 Legacy Computing block. The
// four bit patterns missing from U+1FB00-3B exist as older blocks chars.
const SEXT: string[] = []
for (let b = 0; b < 64; b++) {
  if (b === 0) SEXT.push(' ')
  else if (b === 21) SEXT.push('▌')
  else if (b === 42) SEXT.push('▐')
  else if (b === 63) SEXT.push('█')
  else SEXT.push(String.fromCodePoint(0x1fb00 + b - 1 - (b > 21 ? 1 : 0) - (b > 42 ? 1 : 0)))
}

// wire glyph index -> char, in atlas order (quadrant 0-15, ascii ramp 16-25,
// sextants 26-89); what a text receiver (terminal client) prints per cell
export const GLYPH_CHARS = [...QUAD, ...RAMP, ...SEXT]
export const SEXT_BASE = 26

const HEX: string[] = []
for (let i = 0; i < 256; i++) HEX.push(i.toString(16).padStart(2, '0'))
const hex = (c: number) => '#' + HEX[(c >> 16) & 255] + HEX[(c >> 8) & 255] + HEX[c & 255]

const LUMA_CHAR: string[] = []
for (let l = 0; l < 256; l++) LUMA_CHAR.push(RAMP[((l * (RAMP.length - 1)) / 255) | 0])

export function encodeFrame(img: ImageData, cols: number, rows: number, mode: Mode, qShift: number): Frame {
  if (mode === 'quadrant') return encodeQuadrant(img, cols, rows, qShift)
  if (mode === 'sextant') return encodeSextant(img, cols, rows, qShift)
  if (mode === 'octant') return encodeOctant(img, cols, rows, qShift)
  return mode === 'halfblock'
    ? encodeHalfblock(img, cols, rows, qShift)
    : encodeAscii(img, cols, rows, qShift)
}

let sharpenBuf: Uint8ClampedArray | null = null

export function sharpen(img: ImageData, amount: number): void {
  if (amount <= 0) return
  const { data, width: w, height: h } = img
  if (!sharpenBuf || sharpenBuf.length !== data.length) sharpenBuf = new Uint8ClampedArray(data.length)
  sharpenBuf.set(data)
  const s = sharpenBuf
  const center = 1 + 4 * amount
  const stride = w * 4
  for (let y = 1; y < h - 1; y++) {
    let i = (y * w + 1) * 4
    for (let x = 1; x < w - 1; x++, i += 4) {
      for (let c = 0; c < 3; c++) {
        const j = i + c
        data[j] = s[j] * center - amount * (s[j - 4] + s[j + 4] + s[j - stride] + s[j + stride])
      }
    }
  }
}

function encodeQuadrant(img: ImageData, cols: number, rows: number, qShift: number): Frame {
  const d = img.data
  const W = img.width
  const mask = (255 >> qShift) << qShift
  const out: string[] = []
  let spans = 0
  let htmlBytes = 0
  for (let y = 0; y < rows; y++) {
    let html = ''
    let runFg = -1
    let runBg = -1
    let run = ''
    const top = y * 2 * W * 4
    const bot = (y * 2 + 1) * W * 4
    for (let x = 0; x < cols; x++) {
      const i0 = top + x * 8
      const i1 = i0 + 4
      const i2 = bot + x * 8
      const i3 = i2 + 4
      const l0 = (d[i0] * 54 + d[i0 + 1] * 183 + d[i0 + 2] * 19) >> 8
      const l1 = (d[i1] * 54 + d[i1 + 1] * 183 + d[i1 + 2] * 19) >> 8
      const l2 = (d[i2] * 54 + d[i2 + 1] * 183 + d[i2 + 2] * 19) >> 8
      const l3 = (d[i3] * 54 + d[i3 + 1] * 183 + d[i3 + 2] * 19) >> 8
      const avg = (l0 + l1 + l2 + l3) >> 2
      let bits = 0
      let fr = 0, fgc = 0, fb = 0, fn = 0
      let br = 0, bgc = 0, bb = 0, bn = 0
      if (l0 > avg) { bits |= 1; fr += d[i0]; fgc += d[i0 + 1]; fb += d[i0 + 2]; fn++ } else { br += d[i0]; bgc += d[i0 + 1]; bb += d[i0 + 2]; bn++ }
      if (l1 > avg) { bits |= 2; fr += d[i1]; fgc += d[i1 + 1]; fb += d[i1 + 2]; fn++ } else { br += d[i1]; bgc += d[i1 + 1]; bb += d[i1 + 2]; bn++ }
      if (l2 > avg) { bits |= 4; fr += d[i2]; fgc += d[i2 + 1]; fb += d[i2 + 2]; fn++ } else { br += d[i2]; bgc += d[i2 + 1]; bb += d[i2 + 2]; bn++ }
      if (l3 > avg) { bits |= 8; fr += d[i3]; fgc += d[i3 + 1]; fb += d[i3 + 2]; fn++ } else { br += d[i3]; bgc += d[i3 + 1]; bb += d[i3 + 2]; bn++ }
      const bg = (((br / bn) & mask) << 16) | (((bgc / bn) & mask) << 8) | ((bb / bn) & mask)
      const fg = fn === 0 ? bg : (((fr / fn) & mask) << 16) | (((fgc / fn) & mask) << 8) | ((fb / fn) & mask)
      if (fg === runFg && bg === runBg) {
        run += QUAD[bits]
        continue
      }
      if (run) {
        html += spanFgBg(runFg, runBg, run)
        spans++
      }
      runFg = fg
      runBg = bg
      run = QUAD[bits]
    }
    if (run) {
      html += spanFgBg(runFg, runBg, run)
      spans++
    }
    out.push(html)
    htmlBytes += html.length
  }
  return { rows: out, spans, htmlBytes }
}

function encodeSextant(img: ImageData, cols: number, rows: number, qShift: number): Frame {
  const d = img.data
  const W = img.width
  const mask = (255 >> qShift) << qShift
  const out: string[] = []
  let spans = 0
  let htmlBytes = 0
  const idx = new Array<number>(6)
  for (let y = 0; y < rows; y++) {
    let html = ''
    let runFg = -1
    let runBg = -1
    let run = ''
    for (let x = 0; x < cols; x++) {
      for (let s = 0; s < 6; s++) idx[s] = ((y * 3 + (s >> 1)) * W + x * 2 + (s & 1)) * 4
      let avg = 0
      const lum = new Array<number>(6)
      for (let s = 0; s < 6; s++) {
        const i = idx[s]
        lum[s] = (d[i] * 54 + d[i + 1] * 183 + d[i + 2] * 19) >> 8
        avg += lum[s]
      }
      avg = (avg / 6) | 0
      let bits = 0
      let fr = 0, fgc = 0, fb = 0, fn = 0
      let br = 0, bgc = 0, bb = 0, bn = 0
      for (let s = 0; s < 6; s++) {
        const i = idx[s]
        if (lum[s] > avg) { bits |= 1 << s; fr += d[i]; fgc += d[i + 1]; fb += d[i + 2]; fn++ }
        else { br += d[i]; bgc += d[i + 1]; bb += d[i + 2]; bn++ }
      }
      const bg = (((br / bn) & mask) << 16) | (((bgc / bn) & mask) << 8) | ((bb / bn) & mask)
      const fg = fn === 0 ? bg : (((fr / fn) & mask) << 16) | (((fgc / fn) & mask) << 8) | ((fb / fn) & mask)
      if (fg === runFg && bg === runBg) {
        run += SEXT[bits]
        continue
      }
      if (run) {
        html += spanFgBg(runFg, runBg, run)
        spans++
      }
      runFg = fg
      runBg = bg
      run = SEXT[bits]
    }
    if (run) {
      html += spanFgBg(runFg, runBg, run)
      spans++
    }
    out.push(html)
    htmlBytes += html.length
  }
  return { rows: out, spans, htmlBytes }
}

function encodeOctant(img: ImageData, cols: number, rows: number, qShift: number): Frame {
  const d = img.data
  const W = img.width
  const mask = (255 >> qShift) << qShift
  const out: string[] = []
  let spans = 0
  let htmlBytes = 0
  const idx = new Array<number>(8)
  const lum = new Array<number>(8)
  for (let y = 0; y < rows; y++) {
    let html = ''
    let runFg = -1
    let runBg = -1
    let run = ''
    for (let x = 0; x < cols; x++) {
      let avg = 0
      for (let s = 0; s < 8; s++) {
        const i = ((y * 4 + (s >> 1)) * W + x * 2 + (s & 1)) * 4
        idx[s] = i
        lum[s] = (d[i] * 54 + d[i + 1] * 183 + d[i + 2] * 19) >> 8
        avg += lum[s]
      }
      avg = (avg / 8) | 0
      let bits = 0
      let fr = 0, fgc = 0, fb = 0, fn = 0
      let br = 0, bgc = 0, bb = 0, bn = 0
      for (let s = 0; s < 8; s++) {
        const i = idx[s]
        if (lum[s] > avg) { bits |= 1 << s; fr += d[i]; fgc += d[i + 1]; fb += d[i + 2]; fn++ }
        else { br += d[i]; bgc += d[i + 1]; bb += d[i + 2]; bn++ }
      }
      const bg = bn === 0 ? 0 : (((br / bn) & mask) << 16) | (((bgc / bn) & mask) << 8) | ((bb / bn) & mask)
      const fg = fn === 0 ? bg : (((fr / fn) & mask) << 16) | (((fgc / fn) & mask) << 8) | ((fb / fn) & mask)
      if (fg === runFg && bg === runBg) {
        run += OCT_CHARS[bits]
        continue
      }
      if (run) {
        html += spanFgBg(runFg, runBg, run)
        spans++
      }
      runFg = fg
      runBg = bg
      run = OCT_CHARS[bits]
    }
    if (run) {
      html += spanFgBg(runFg, runBg, run)
      spans++
    }
    out.push(html)
    htmlBytes += html.length
  }
  return { rows: out, spans, htmlBytes }
}

function encodeHalfblock(img: ImageData, cols: number, rows: number, qShift: number): Frame {
  const d = img.data
  const mask = (255 >> qShift) << qShift
  const out: string[] = []
  let spans = 0
  let htmlBytes = 0
  for (let y = 0; y < rows; y++) {
    let html = ''
    let runFg = -1
    let runBg = -1
    let run = ''
    const ti = y * 2 * cols * 4
    const bi = (y * 2 + 1) * cols * 4
    for (let x = 0; x < cols; x++) {
      const t = ti + x * 4
      const b = bi + x * 4
      const fg = ((d[t] & mask) << 16) | ((d[t + 1] & mask) << 8) | (d[t + 2] & mask)
      const bg = ((d[b] & mask) << 16) | ((d[b + 1] & mask) << 8) | (d[b + 2] & mask)
      if (fg === runFg && bg === runBg) {
        run += HB
        continue
      }
      if (run) {
        html += spanFgBg(runFg, runBg, run)
        spans++
      }
      runFg = fg
      runBg = bg
      run = HB
    }
    if (run) {
      html += spanFgBg(runFg, runBg, run)
      spans++
    }
    out.push(html)
    htmlBytes += html.length
  }
  return { rows: out, spans, htmlBytes }
}

function encodeAscii(img: ImageData, cols: number, rows: number, qShift: number): Frame {
  const d = img.data
  const mask = (255 >> qShift) << qShift
  const out: string[] = []
  let spans = 0
  let htmlBytes = 0
  for (let y = 0; y < rows; y++) {
    let html = ''
    let runFg = -1
    let run = ''
    const ti = y * 2 * cols * 4
    const bi = (y * 2 + 1) * cols * 4
    for (let x = 0; x < cols; x++) {
      const t = ti + x * 4
      const b = bi + x * 4
      const r = (d[t] + d[b]) >> 1
      const g = (d[t + 1] + d[b + 1]) >> 1
      const bl = (d[t + 2] + d[b + 2]) >> 1
      const luma = (r * 54 + g * 183 + bl * 19) >> 8
      const ch = LUMA_CHAR[luma]
      const fg = ch === ' ' ? 0 : ((r & mask) << 16) | ((g & mask) << 8) | (bl & mask)
      if (fg === runFg) {
        run += ch
        continue
      }
      if (run) {
        html += spanFg(runFg, run)
        spans++
      }
      runFg = fg
      run = ch
    }
    if (run) {
      html += spanFg(runFg, run)
      spans++
    }
    out.push(html)
    htmlBytes += html.length
  }
  return { rows: out, spans, htmlBytes }
}

// GPU path: fills fg/bg RGBA cell buffers (fg alpha = glyph atlas index)
// instead of HTML strings. Atlas order: QUAD[0..15] then RAMP[0..9].
export function encodeCells(
  img: PixelSource,
  cols: number,
  rows: number,
  mode: Mode,
  qShift: number,
  fg: Uint8Array,
  bg: Uint8Array,
): void {
  const d = img.data
  const W = img.width
  const mask = (255 >> qShift) << qShift

  if (mode === 'quadrant') {
    for (let y = 0; y < rows; y++) {
      const top = y * 2 * W * 4
      const bot = (y * 2 + 1) * W * 4
      let o = y * cols * 4
      for (let x = 0; x < cols; x++, o += 4) {
        const i0 = top + x * 8
        const i1 = i0 + 4
        const i2 = bot + x * 8
        const i3 = i2 + 4
        const l0 = (d[i0] * 54 + d[i0 + 1] * 183 + d[i0 + 2] * 19) >> 8
        const l1 = (d[i1] * 54 + d[i1 + 1] * 183 + d[i1 + 2] * 19) >> 8
        const l2 = (d[i2] * 54 + d[i2 + 1] * 183 + d[i2 + 2] * 19) >> 8
        const l3 = (d[i3] * 54 + d[i3 + 1] * 183 + d[i3 + 2] * 19) >> 8
        const avg = (l0 + l1 + l2 + l3) >> 2
        let bits = 0
        let fr = 0, fgc = 0, fb = 0, fn = 0
        let br = 0, bgc = 0, bb = 0, bn = 0
        if (l0 > avg) { bits |= 1; fr += d[i0]; fgc += d[i0 + 1]; fb += d[i0 + 2]; fn++ } else { br += d[i0]; bgc += d[i0 + 1]; bb += d[i0 + 2]; bn++ }
        if (l1 > avg) { bits |= 2; fr += d[i1]; fgc += d[i1 + 1]; fb += d[i1 + 2]; fn++ } else { br += d[i1]; bgc += d[i1 + 1]; bb += d[i1 + 2]; bn++ }
        if (l2 > avg) { bits |= 4; fr += d[i2]; fgc += d[i2 + 1]; fb += d[i2 + 2]; fn++ } else { br += d[i2]; bgc += d[i2 + 1]; bb += d[i2 + 2]; bn++ }
        if (l3 > avg) { bits |= 8; fr += d[i3]; fgc += d[i3 + 1]; fb += d[i3 + 2]; fn++ } else { br += d[i3]; bgc += d[i3 + 1]; bb += d[i3 + 2]; bn++ }
        bg[o] = (br / bn) & mask
        bg[o + 1] = (bgc / bn) & mask
        bg[o + 2] = (bb / bn) & mask
        bg[o + 3] = 255
        if (fn === 0) {
          fg[o] = bg[o]
          fg[o + 1] = bg[o + 1]
          fg[o + 2] = bg[o + 2]
        } else {
          fg[o] = (fr / fn) & mask
          fg[o + 1] = (fgc / fn) & mask
          fg[o + 2] = (fb / fn) & mask
        }
        fg[o + 3] = bits
      }
    }
    return
  }

  if (mode === 'octant') {
    const idx = new Array<number>(8)
    const lum = new Array<number>(8)
    for (let y = 0; y < rows; y++) {
      let o = y * cols * 4
      for (let x = 0; x < cols; x++, o += 4) {
        let avg = 0
        for (let s = 0; s < 8; s++) {
          const i = ((y * 4 + (s >> 1)) * W + x * 2 + (s & 1)) * 4
          idx[s] = i
          lum[s] = (d[i] * 54 + d[i + 1] * 183 + d[i + 2] * 19) >> 8
          avg += lum[s]
        }
        avg = (avg / 8) | 0
        let bits = 0
        let fr = 0, fgc = 0, fb = 0, fn = 0
        let br = 0, bgc = 0, bb = 0, bn = 0
        for (let s = 0; s < 8; s++) {
          const i = idx[s]
          if (lum[s] > avg) { bits |= 1 << s; fr += d[i]; fgc += d[i + 1]; fb += d[i + 2]; fn++ }
          else { br += d[i]; bgc += d[i + 1]; bb += d[i + 2]; bn++ }
        }
        if (bn === 0) {
          bg[o] = bg[o + 1] = bg[o + 2] = 0
        } else {
          bg[o] = (br / bn) & mask
          bg[o + 1] = (bgc / bn) & mask
          bg[o + 2] = (bb / bn) & mask
        }
        bg[o + 3] = 255
        if (fn === 0) {
          fg[o] = bg[o]
          fg[o + 1] = bg[o + 1]
          fg[o + 2] = bg[o + 2]
        } else {
          fg[o] = (fr / fn) & mask
          fg[o + 1] = (fgc / fn) & mask
          fg[o + 2] = (fb / fn) & mask
        }
        fg[o + 3] = bits
      }
    }
    return
  }

  if (mode === 'sextant') {
    const idx = new Array<number>(6)
    const lum = new Array<number>(6)
    for (let y = 0; y < rows; y++) {
      let o = y * cols * 4
      for (let x = 0; x < cols; x++, o += 4) {
        let avg = 0
        for (let s = 0; s < 6; s++) {
          const i = ((y * 3 + (s >> 1)) * W + x * 2 + (s & 1)) * 4
          idx[s] = i
          lum[s] = (d[i] * 54 + d[i + 1] * 183 + d[i + 2] * 19) >> 8
          avg += lum[s]
        }
        avg = (avg / 6) | 0
        let bits = 0
        let fr = 0, fgc = 0, fb = 0, fn = 0
        let br = 0, bgc = 0, bb = 0, bn = 0
        for (let s = 0; s < 6; s++) {
          const i = idx[s]
          if (lum[s] > avg) { bits |= 1 << s; fr += d[i]; fgc += d[i + 1]; fb += d[i + 2]; fn++ }
          else { br += d[i]; bgc += d[i + 1]; bb += d[i + 2]; bn++ }
        }
        bg[o] = (br / bn) & mask
        bg[o + 1] = (bgc / bn) & mask
        bg[o + 2] = (bb / bn) & mask
        bg[o + 3] = 255
        if (fn === 0) {
          fg[o] = bg[o]
          fg[o + 1] = bg[o + 1]
          fg[o + 2] = bg[o + 2]
        } else {
          fg[o] = (fr / fn) & mask
          fg[o + 1] = (fgc / fn) & mask
          fg[o + 2] = (fb / fn) & mask
        }
        fg[o + 3] = 26 + bits
      }
    }
    return
  }

  if (mode === 'halfblock') {
    for (let y = 0; y < rows; y++) {
      const ti = y * 2 * W * 4
      const bi = (y * 2 + 1) * W * 4
      let o = y * cols * 4
      for (let x = 0; x < cols; x++, o += 4) {
        const t = ti + x * 4
        const b = bi + x * 4
        fg[o] = d[t] & mask
        fg[o + 1] = d[t + 1] & mask
        fg[o + 2] = d[t + 2] & mask
        fg[o + 3] = 3
        bg[o] = d[b] & mask
        bg[o + 1] = d[b + 1] & mask
        bg[o + 2] = d[b + 2] & mask
        bg[o + 3] = 255
      }
    }
    return
  }

  for (let y = 0; y < rows; y++) {
    const ti = y * 2 * W * 4
    const bi = (y * 2 + 1) * W * 4
    let o = y * cols * 4
    for (let x = 0; x < cols; x++, o += 4) {
      const t = ti + x * 4
      const b = bi + x * 4
      const r = (d[t] + d[b]) >> 1
      const g = (d[t + 1] + d[b + 1]) >> 1
      const bl = (d[t + 2] + d[b + 2]) >> 1
      const luma = (r * 54 + g * 183 + bl * 19) >> 8
      fg[o] = r & mask
      fg[o + 1] = g & mask
      fg[o + 2] = bl & mask
      fg[o + 3] = 16 + (((luma * (RAMP.length - 1)) / 255) | 0)
      bg[o] = 0
      bg[o + 1] = 0
      bg[o + 2] = 0
      bg[o + 3] = 255
    }
  }
}

const spanFgBg = (fg: number, bg: number, text: string) =>
  `<span style="color:${hex(fg)};background:${hex(bg)}">${text}</span>`

const spanFg = (fg: number, text: string) => `<span style="color:${hex(fg)}">${text}</span>`

// invert=true flips the ramp so denser characters read as DARKER (the
// conventional ASCII-art direction an LLM expects), instead of the codec's
// native denser=brighter mapping. Used by the "feed a frame to your LLM" demo.
export function frameToPlainText(img: PixelSource, cols: number, rows: number, invert = false): string {
  const d = img.data
  const W = img.width
  const sx = (W / cols) | 0
  const sy = (img.height / rows) | 0
  const n = sx * sy
  const lines: string[] = []
  for (let y = 0; y < rows; y++) {
    let line = ''
    for (let x = 0; x < cols; x++) {
      let r = 0, g = 0, b = 0
      for (let dy = 0; dy < sy; dy++) {
        for (let dx = 0; dx < sx; dx++) {
          const i = ((y * sy + dy) * W + x * sx + dx) * 4
          r += d[i]
          g += d[i + 1]
          b += d[i + 2]
        }
      }
      const luma = (((r / n) | 0) * 54 + ((g / n) | 0) * 183 + ((b / n) | 0) * 19) >> 8
      line += LUMA_CHAR[invert ? 255 - luma : luma]
    }
    lines.push(line)
  }
  return lines.join('\n')
}
