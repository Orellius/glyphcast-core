// SPDX-License-Identifier: Apache-2.0
// Self-contained terminal proof: no browser, no GPU, no server. Generate frames
// (the drifting gradient) -> encodeCells -> pack -> unpack -> render ANSI, in a
// loop, over the exact wire format clients/term.ts decodes. The whole thesis -
// "video as text, decodable by a terminal" - from one Bun process.
// Run: bun examples/terminal-demo.ts
// Env: GC_COLS (100) · GC_MODE (octant) · GC_WIRE (color) · GC_DEPTH (888) · GC_FRAMES (240)

import { encodeCells, sampleX, sampleY, type Mode } from '../src/encode'
import { createWireState, pack, unpack, type WireDepth, type WireMode } from '../src/wire'
import { gradientFrame } from '../src/gradient'
import { renderAnsi } from '../clients/ansi'

const cols = Number(process.env.GC_COLS ?? 100)
const mode = (process.env.GC_MODE ?? 'octant') as Mode
const wireMode = (process.env.GC_WIRE ?? 'color') as WireMode
const depth = (process.env.GC_DEPTH ?? '888') as WireDepth
const maxFrames = Number(process.env.GC_FRAMES ?? 240)

const sx = sampleX(mode)
const sy = sampleY(mode)
const rows = Math.max(2, Math.round((cols * sx) / (sy * (16 / 9))))
const w = cols * sx
const h = rows * sy
const octantPage = mode === 'octant'

const fg = new Uint8Array(cols * rows * 4)
const bg = new Uint8Array(cols * rows * 4)
const sender = createWireState(cols, rows)
const recv = createWireState(cols, rows)
const scratch = new Uint8ClampedArray(w * h * 4)

const fps = 24
const showCursor = () => process.stdout.write('\x1b[?25h')
process.on('SIGINT', () => { showCursor(); process.exit(0) })
process.stdout.write('\x1b[2J\x1b[?25l')

let frame = 0
const timer = setInterval(() => {
  const img = gradientFrame(w, h, frame / fps, scratch)
  encodeCells(img, cols, rows, mode, 0, fg, bg)
  const packed = pack(sender, fg, bg, wireMode, octantPage, depth)
  unpack(packed, recv)
  const tty = process.stdout.isTTY
  const vc = tty ? Math.min(cols, process.stdout.columns || cols) : cols
  const vr = tty ? Math.min(rows, (process.stdout.rows || rows + 2) - 2) : rows
  process.stdout.write(renderAnsi(recv, wireMode, octantPage, depth === '888', vc, vr))
  if (++frame >= maxFrames) {
    clearInterval(timer)
    showCursor()
    process.exit(0)
  }
}, 1000 / fps)
