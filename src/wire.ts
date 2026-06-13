// SPDX-License-Identifier: Apache-2.0
// glyphcast wire format v1: a video frame as a stream of typography cells,
// built for ultra-low bandwidth and dumb receivers (terminals, MCUs).
// Cell = glyph index + (color mode) fg/bg in RGB565 (bandwidth tier) or
// RGB888 (fidelity tier, header bit 2 - kills 5/6-bit banding). Frames are
// skip/emit run pairs vs the previous frame: [u16 skip][u16 emit][payloads].
// Byte-aligned, no entropy coding - an ESP32 or a shell script can decode it;
// transport-level deflate is measured separately.
// NOT responsible for: pixel->cell encoding (encode.ts), transport, rendering.
// Test strategy: pack/unpack roundtrip equality + live bitrate bench via __gc.

export type WireMode = 'color' | 'mono'
export type WireDepth = '565' | '888'

// receiver-side cell state; pack() also consumes it as the prev-frame
// reference. fg/bg hold wire-precision values: 565 in the low 16 bits or
// packed 0xRRGGBB, per the stream's depth.
export type WireState = {
  cols: number
  rows: number
  glyph: Uint8Array
  fg: Uint32Array
  bg: Uint32Array
  scratch?: Uint8Array
}

export function createWireState(cols: number, rows: number): WireState {
  const n = cols * rows
  return { cols, rows, glyph: new Uint8Array(n).fill(255), fg: new Uint32Array(n), bg: new Uint32Array(n) }
}

const to565 = (buf: Uint8Array, i: number) =>
  ((buf[i] >> 3) << 11) | ((buf[i + 1] >> 2) << 5) | (buf[i + 2] >> 3)
const to888 = (buf: Uint8Array, i: number) => (buf[i] << 16) | (buf[i + 1] << 8) | buf[i + 2]

const HDR = 5
const payloadBytes = (mode: WireMode, depth: WireDepth) => (mode === 'color' ? (depth === '888' ? 7 : 5) : 1)

// fg/bg are encodeCells output (RGBA, glyph idx in fg alpha). Updates state in
// place to the new frame and returns the packed delta (keyframe when state is
// fresh: every cell differs from the 255 sentinel). octantPage flags header
// bit 1: glyph bytes are octant bitmasks (their own 256-glyph page), not
// indices into the base quadrant/ramp/sextant atlas.
export function pack(state: WireState, fg: Uint8Array, bg: Uint8Array, mode: WireMode, octantPage = false, depth: WireDepth = '565'): Uint8Array {
  const n = state.cols * state.rows
  const pb = payloadBytes(mode, depth)
  // scratch reuse: at high cell counts a fresh multi-MB buffer per frame is
  // GC-storm fuel. The returned view aliases state.scratch - callers must
  // consume it before the next pack on the same state (ws.send copies
  // synchronously; benches must .slice() to retain).
  const cap = HDR + n * (pb + 4) + 8
  if (!state.scratch || state.scratch.length < cap) state.scratch = new Uint8Array(cap)
  const out = state.scratch
  out[0] = (mode === 'color' ? 1 : 0) | (octantPage ? 2 : 0) | (depth === '888' ? 4 : 0)
  out[1] = state.cols & 255
  out[2] = state.cols >> 8
  out[3] = state.rows & 255
  out[4] = state.rows >> 8
  let w = HDR
  let i = 0
  while (i < n) {
    let skip = 0
    while (i < n && !cellChanged(state, fg, bg, i, mode, depth)) {
      skip++
      i++
    }
    if (i >= n && skip > 0) break
    if (i >= n) break
    let emitStart = i
    while (i < n && cellChanged(state, fg, bg, i, mode, depth) && i - emitStart < 65535) i++
    const emit = i - emitStart
    while (skip > 65535) {
      out[w++] = 255; out[w++] = 255; out[w++] = 0; out[w++] = 0
      skip -= 65535
    }
    out[w++] = skip & 255
    out[w++] = skip >> 8
    out[w++] = emit & 255
    out[w++] = emit >> 8
    for (let c = emitStart; c < i; c++) {
      const g = fg[c * 4 + 3]
      state.glyph[c] = g
      out[w++] = g
      if (mode !== 'color') continue
      if (depth === '888') {
        const f8 = to888(fg, c * 4)
        const b8 = to888(bg, c * 4)
        state.fg[c] = f8
        state.bg[c] = b8
        out[w++] = (f8 >> 16) & 255
        out[w++] = (f8 >> 8) & 255
        out[w++] = f8 & 255
        out[w++] = (b8 >> 16) & 255
        out[w++] = (b8 >> 8) & 255
        out[w++] = b8 & 255
      } else {
        const f5 = to565(fg, c * 4)
        const b5 = to565(bg, c * 4)
        state.fg[c] = f5
        state.bg[c] = b5
        out[w++] = f5 & 255
        out[w++] = f5 >> 8
        out[w++] = b5 & 255
        out[w++] = b5 >> 8
      }
    }
  }
  return out.subarray(0, w)
}

function cellChanged(state: WireState, fg: Uint8Array, bg: Uint8Array, i: number, mode: WireMode, depth: WireDepth): boolean {
  if (state.glyph[i] !== fg[i * 4 + 3]) return true
  if (mode === 'mono') return false
  if (depth === '888') return state.fg[i] !== to888(fg, i * 4) || state.bg[i] !== to888(bg, i * 4)
  return state.fg[i] !== to565(fg, i * 4) || state.bg[i] !== to565(bg, i * 4)
}

// applies a packed frame onto receiver state; returns cells touched
export function unpack(buf: Uint8Array, state: WireState): number {
  const mode: WireMode = buf[0] & 1 ? 'color' : 'mono'
  const depth: WireDepth = buf[0] & 4 ? '888' : '565'
  const cols = buf[1] | (buf[2] << 8)
  const rows = buf[3] | (buf[4] << 8)
  if (cols !== state.cols || rows !== state.rows) throw new Error(`grid mismatch: ${cols}x${rows} vs state ${state.cols}x${state.rows}`)
  let r = HDR
  let i = 0
  let touched = 0
  while (r < buf.length) {
    const skip = buf[r] | (buf[r + 1] << 8)
    const emit = buf[r + 2] | (buf[r + 3] << 8)
    r += 4
    i += skip
    for (let e = 0; e < emit; e++, i++) {
      state.glyph[i] = buf[r++]
      if (mode !== 'color') continue
      if (depth === '888') {
        state.fg[i] = (buf[r] << 16) | (buf[r + 1] << 8) | buf[r + 2]
        state.bg[i] = (buf[r + 3] << 16) | (buf[r + 4] << 8) | buf[r + 5]
        r += 6
      } else {
        state.fg[i] = buf[r] | (buf[r + 1] << 8)
        state.bg[i] = buf[r + 2] | (buf[r + 3] << 8)
        r += 4
      }
    }
    touched += emit
  }
  return touched
}

export function statesEqual(a: WireState, b: WireState, mode: WireMode): boolean {
  for (let i = 0; i < a.glyph.length; i++) {
    if (a.glyph[i] !== b.glyph[i]) return false
    if (mode === 'color' && (a.fg[i] !== b.fg[i] || a.bg[i] !== b.bg[i])) return false
  }
  return true
}

// expands receiver state into the RGBA cell buffers renderer_gl.render eats:
// fg rgb (565 bit-replicated or 888 verbatim) + glyph idx in fg alpha; bg rgb.
// Mono mode renders white-on-black from glyphs alone.
export function stateToCells(state: WireState, mode: WireMode, fg: Uint8Array, bg: Uint8Array, depth: WireDepth = '565'): void {
  const n = state.cols * state.rows
  for (let i = 0; i < n; i++) {
    const o = i * 4
    if (mode === 'color' && depth === '888') {
      const f = state.fg[i]
      const b = state.bg[i]
      fg[o] = (f >> 16) & 255
      fg[o + 1] = (f >> 8) & 255
      fg[o + 2] = f & 255
      bg[o] = (b >> 16) & 255
      bg[o + 1] = (b >> 8) & 255
      bg[o + 2] = b & 255
    } else if (mode === 'color') {
      const f = state.fg[i]
      const b = state.bg[i]
      const fr = (f >> 11) & 31
      const fgr = (f >> 5) & 63
      const fb = f & 31
      const br = (b >> 11) & 31
      const bgr = (b >> 5) & 63
      const bb = b & 31
      fg[o] = (fr << 3) | (fr >> 2)
      fg[o + 1] = (fgr << 2) | (fgr >> 4)
      fg[o + 2] = (fb << 3) | (fb >> 2)
      bg[o] = (br << 3) | (br >> 2)
      bg[o + 1] = (bgr << 2) | (bgr >> 4)
      bg[o + 2] = (bb << 3) | (bb >> 2)
    } else {
      fg[o] = fg[o + 1] = fg[o + 2] = 230
      bg[o] = bg[o + 1] = bg[o + 2] = 0
    }
    fg[o + 3] = state.glyph[i]
    bg[o + 3] = 255
  }
}

// cheap state fingerprint for cast/view convergence asserts in E2E
export function stateChecksum(state: WireState, mode: WireMode): number {
  let h = 0
  for (let i = 0; i < state.glyph.length; i++) {
    h = (h * 31 + state.glyph[i]) >>> 0
    if (mode === 'color') h = (h * 31 + state.fg[i] + state.bg[i] * 7) >>> 0
  }
  return h
}

// total deflated size of a frame sequence with shared context - honest stand-in
// for WS permessage-deflate with context takeover
export async function deflatedSize(frames: Uint8Array[]): Promise<number> {
  const cs = new CompressionStream('deflate-raw')
  const writer = cs.writable.getWriter()
  const done = new Response(cs.readable).arrayBuffer()
  for (const f of frames) await writer.write(f as Uint8Array<ArrayBuffer>)
  await writer.close()
  return (await done).byteLength
}
