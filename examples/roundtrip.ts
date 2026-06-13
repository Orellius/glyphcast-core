// SPDX-License-Identifier: Apache-2.0
// Lossless wire-roundtrip assertion - the codec's correctness floor, runnable as
// `bun test`. For every mode × wire-mode × depth, generate gradient frames,
// pack -> unpack, and assert the receiver state matches the sender bit-for-bit
// (statesEqual + identical checksum). Exits non-zero on any mismatch.

import { encodeCells, sampleX, sampleY, type Mode } from '../src/encode'
import {
  createWireState, pack, unpack, statesEqual, stateChecksum,
  type WireDepth, type WireMode,
} from '../src/wire'
import { gradientFrame } from '../src/gradient'

const MODES: Mode[] = ['quadrant', 'sextant', 'octant', 'halfblock', 'ascii']
const WIRES: WireMode[] = ['color', 'mono']
const DEPTHS: WireDepth[] = ['565', '888']
const COLS = 120
const FRAMES = 8

let pass = 0
let fail = 0

for (const mode of MODES) {
  for (const wireMode of WIRES) {
    for (const depth of DEPTHS) {
      const sx = sampleX(mode)
      const sy = sampleY(mode)
      const rows = Math.max(2, Math.round((COLS * sx) / (sy * (16 / 9))))
      const w = COLS * sx
      const h = rows * sy
      const octantPage = mode === 'octant'
      const fg = new Uint8Array(COLS * rows * 4)
      const bg = new Uint8Array(COLS * rows * 4)
      const sender = createWireState(COLS, rows)
      const recv = createWireState(COLS, rows)
      const scratch = new Uint8ClampedArray(w * h * 4)

      let ok = true
      for (let f = 0; f < FRAMES; f++) {
        const img = gradientFrame(w, h, f * 0.25, scratch)
        encodeCells(img, COLS, rows, mode, 0, fg, bg)
        const packed = pack(sender, fg, bg, wireMode, octantPage, depth)
        unpack(packed, recv)
        if (!statesEqual(sender, recv, wireMode) || stateChecksum(sender, wireMode) !== stateChecksum(recv, wireMode)) {
          ok = false
          break
        }
      }
      const label = `${mode}/${wireMode}/${depth}`.padEnd(22)
      if (ok) {
        pass++
        console.log(`  \x1b[32m✓\x1b[0m ${label} ${COLS}×${rows}, ${FRAMES} frames`)
      } else {
        fail++
        console.log(`  \x1b[31m✗\x1b[0m ${label} MISMATCH`)
      }
    }
  }
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
