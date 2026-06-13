// SPDX-License-Identifier: Apache-2.0
// Renders receiver wire state to an ANSI truecolor string - the proof that a
// terminal is a full glyphcast receiver. Shared by the live viewer (term.ts)
// and the self-contained demo (examples/terminal-demo.ts).
// NOT responsible for: transport (term.ts), the codec (src/*).

import { GLYPH_CHARS } from '../src/encode'
import { OCT_CHARS } from '../src/octants'
import type { WireMode, WireState } from '../src/wire'

// expand an N-bit RGB565 channel (bits hi..lo) to 8-bit, bit-replicated
const up = (v: number, hi: number, lo: number) => {
  const bits = hi - lo
  const x = (v >> lo) & ((1 << bits) - 1)
  return (x << (8 - bits)) | (x >> (2 * bits - 8))
}

export function renderAnsi(
  s: WireState,
  mode: WireMode,
  octantPage: boolean,
  depth888: boolean,
  maxCols?: number,
  maxRows?: number,
): string {
  const cols = maxCols ? Math.min(s.cols, maxCols) : s.cols
  const rows = maxRows ? Math.min(s.rows, maxRows) : s.rows
  let out = '\x1b[H'
  for (let y = 0; y < rows; y++) {
    let lastFg = -1
    let lastBg = -1
    for (let x = 0; x < cols; x++) {
      const i = y * s.cols + x
      const g = s.glyph[i]
      if (g === 255 && !octantPage) {
        out += ' '
        continue
      }
      if (mode === 'color') {
        const f = s.fg[i]
        const b = s.bg[i]
        if (f !== lastFg) {
          out += depth888
            ? `\x1b[38;2;${(f >> 16) & 255};${(f >> 8) & 255};${f & 255}m`
            : `\x1b[38;2;${up(f, 16, 11)};${up(f, 11, 5)};${up(f, 5, 0)}m`
          lastFg = f
        }
        if (b !== lastBg) {
          out += depth888
            ? `\x1b[48;2;${(b >> 16) & 255};${(b >> 8) & 255};${b & 255}m`
            : `\x1b[48;2;${up(b, 16, 11)};${up(b, 11, 5)};${up(b, 5, 0)}m`
          lastBg = b
        }
      }
      out += (octantPage ? OCT_CHARS[g] : GLYPH_CHARS[g]) ?? ' '
    }
    out += '\x1b[0m\n'
  }
  return out
}
