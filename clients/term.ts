// SPDX-License-Identifier: Apache-2.0
// glyphcast terminal viewer (Bun): the dumb-receiver proof. No browser, no GPU,
// no pixels - a WebSocket, the wire unpack, and ANSI truecolor. It needs a wire
// relay to connect to: a one-caster / N-viewer WebSocket broadcast that forwards
// packed frames. glyphcast-core ships the codec, not the relay - point this at
// any server that speaks the wire format, or run examples/terminal-demo.ts for a
// self-contained loop with no server at all.
// Run: bun clients/term.ts [ws://host:8788]   Env: GC_CH=channel  GC_FRAMES=N
// (GC_FRAMES exits after N frames and prints {frames, checksum} JSON to stderr -
// the E2E hook for checksum convergence against a caster.)

import { createWireState, stateChecksum, unpack, type WireMode, type WireState } from '../src/wire'
import { renderAnsi } from './ansi'

const wsUrl = process.argv[2] ?? 'ws://localhost:8788'
const channel = process.env.GC_CH ?? 'main'
const maxFrames = Number(process.env.GC_FRAMES ?? 0)

let state: WireState | null = null
let mode: WireMode = 'color'
let octantPage = false
let depth888 = false
let frames = 0

const ws = new WebSocket(`${wsUrl}/?role=view&ch=${encodeURIComponent(channel)}`)
ws.binaryType = 'arraybuffer'

ws.onmessage = (e) => {
  if (typeof e.data === 'string') return
  const pkt = new Uint8Array(e.data as ArrayBuffer)
  if (pkt[0] & 0x80) return // skip audio packets - not part of the core codec
  mode = pkt[0] & 1 ? 'color' : 'mono'
  octantPage = (pkt[0] & 2) !== 0
  depth888 = (pkt[0] & 4) !== 0
  const cols = pkt[1] | (pkt[2] << 8)
  const rows = pkt[3] | (pkt[4] << 8)
  if (!state || state.cols !== cols || state.rows !== rows) {
    state = createWireState(cols, rows)
    process.stdout.write('\x1b[2J')
  }
  unpack(pkt, state)
  const tty = process.stdout.isTTY
  const vc = tty ? Math.min(state.cols, process.stdout.columns || state.cols) : state.cols
  const vr = tty ? Math.min(state.rows, (process.stdout.rows || state.rows + 2) - 2) : state.rows
  process.stdout.write(renderAnsi(state, mode, octantPage, depth888, vc, vr))
  frames++
  if (maxFrames && frames >= maxFrames) {
    process.stderr.write(JSON.stringify({ frames, checksum: stateChecksum(state, mode), cols, rows, mode }) + '\n')
    ws.close()
    process.exit(0)
  }
}

ws.onerror = () => {
  process.stderr.write(`cannot reach relay at ${wsUrl}\n`)
  process.exit(1)
}

console.log(`glyphcast term viewer -> ${wsUrl} (waiting for caster)`)
