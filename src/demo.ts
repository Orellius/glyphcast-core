// SPDX-License-Identifier: Apache-2.0
// Live demo glue: drives the whole codec pipeline in the browser and proves it
// on screen - source frame -> encodeCells -> pack -> unpack -> render - showing
// the real wire byte count and a live wire-roundtrip lossless check. Default
// source is the zero-asset gradient; drop a video file to feed real frames.
// NOT responsible for the codec itself (src/encode, src/wire, src/renderer_gl).
// Test strategy: load the page, confirm "lossless" stays green and fps is sane.

import { encodeCells, frameToPlainText, sampleX, sampleY, type Mode, type PixelSource } from './encode'
import { createRendererGL } from './renderer_gl'
import {
  createWireState, pack, unpack, stateToCells, stateChecksum,
  type WireMode, type WireDepth, type WireState,
} from './wire'
import { gradientFrame } from './gradient'

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const canvas = byId<HTMLCanvasElement>('screen')
const colsInput = byId<HTMLInputElement>('cols')
const colsVal = byId<HTMLSpanElement>('colsVal')
const modeSel = byId<HTMLSelectElement>('mode')
const wireSel = byId<HTMLSelectElement>('wire')
const depthSel = byId<HTMLSelectElement>('depth')
const copyBtn = byId<HTMLButtonElement>('copy')
const gradBtn = byId<HTMLButtonElement>('grad')
const statsEl = byId<HTMLDivElement>('stats')

const renderer = createRendererGL(canvas)

type Cfg = { cols: number; mode: Mode; wireMode: WireMode; depth: WireDepth }
const cfg: Cfg = { cols: 240, mode: 'octant', wireMode: 'color', depth: '888' }

type Rig = {
  cols: number; rows: number; w: number; h: number
  fg: Uint8Array; bg: Uint8Array; recvFg: Uint8Array; recvBg: Uint8Array
  sender: WireState; recv: WireState
  scratch: Uint8ClampedArray
  sampleCtx: CanvasRenderingContext2D
}

let source: 'gradient' | 'video' = 'gradient'
let video: HTMLVideoElement | null = null
let lastImg: PixelSource | null = null
let rig = buildRig()

function buildRig(): Rig {
  const sx = sampleX(cfg.mode)
  const sy = sampleY(cfg.mode)
  const aspect = source === 'video' && video ? video.videoWidth / video.videoHeight : 16 / 9
  const cols = cfg.cols
  const rows = Math.max(2, Math.round((cols * sx) / (sy * aspect)))
  const w = cols * sx
  const h = rows * sy
  const n = cols * rows * 4
  const sample = document.createElement('canvas')
  sample.width = w
  sample.height = h
  return {
    cols, rows, w, h,
    fg: new Uint8Array(n), bg: new Uint8Array(n),
    recvFg: new Uint8Array(n), recvBg: new Uint8Array(n),
    sender: createWireState(cols, rows), recv: createWireState(cols, rows),
    scratch: new Uint8ClampedArray(w * h * 4),
    sampleCtx: sample.getContext('2d', { willReadFrequently: true })!,
  }
}

function rebuild() {
  rig = buildRig()
}

// stats
let frames = 0
let fps = 0
let statTimer = 0
let lastBytes = 0
let lossless = true

let t = 0
let last = performance.now()

function tick(now: number) {
  const dt = Math.min((now - last) / 1000, 0.1)
  last = now
  t += dt

  let img: PixelSource
  if (source === 'video' && video && video.readyState >= 2) {
    rig.sampleCtx.drawImage(video, 0, 0, rig.w, rig.h)
    img = rig.sampleCtx.getImageData(0, 0, rig.w, rig.h)
  } else {
    img = gradientFrame(rig.w, rig.h, t, rig.scratch)
  }
  lastImg = img

  encodeCells(img, rig.cols, rig.rows, cfg.mode, 0, rig.fg, rig.bg)
  const octantPage = cfg.mode === 'octant'
  const packed = pack(rig.sender, rig.fg, rig.bg, cfg.wireMode, octantPage, cfg.depth)
  lastBytes = packed.length
  unpack(packed, rig.recv)
  stateToCells(rig.recv, cfg.wireMode, rig.recvFg, rig.recvBg, cfg.depth)
  renderer.render(rig.recvFg, rig.recvBg, rig.cols, rig.rows, octantPage)

  lossless = stateChecksum(rig.sender, cfg.wireMode) === stateChecksum(rig.recv, cfg.wireMode)

  frames++
  statTimer += dt
  if (statTimer >= 0.5) {
    fps = frames / statTimer
    frames = 0
    statTimer = 0
    paintStats()
  }
  requestAnimationFrame(tick)
}

function paintStats() {
  const cells = rig.cols * rig.rows
  const mbps = (lastBytes * 8 * fps) / 1e6
  const kb = (lastBytes / 1024).toFixed(1)
  statsEl.innerHTML =
    `<b>${cells.toLocaleString()}</b> cells &nbsp;·&nbsp; ${rig.cols}×${rig.rows} &nbsp;·&nbsp; ` +
    `<b>${kb}</b> KB/frame &nbsp;·&nbsp; ~<b>${mbps.toFixed(1)}</b> Mbps @ ${fps.toFixed(0)} fps &nbsp;·&nbsp; ` +
    `wire roundtrip: <span class="${lossless ? 'ok' : 'bad'}">${lossless ? 'lossless ✓' : 'MISMATCH ✗'}</span>`
}

function resize() {
  const r = canvas.parentElement!.getBoundingClientRect()
  renderer.resize(r.width, r.height)
}

// controls
colsInput.addEventListener('input', () => {
  cfg.cols = Number(colsInput.value)
  colsVal.textContent = String(cfg.cols)
  rebuild()
})
modeSel.addEventListener('change', () => { cfg.mode = modeSel.value as Mode; rebuild() })
wireSel.addEventListener('change', () => { cfg.wireMode = wireSel.value as WireMode; rebuild() })
depthSel.addEventListener('change', () => { cfg.depth = depthSel.value as WireDepth; rebuild() })

copyBtn.addEventListener('click', async () => {
  if (!lastImg) return
  const text = frameToPlainText(lastImg, rig.cols, rig.rows, true)
  await navigator.clipboard.writeText(text)
  copyBtn.textContent = `copied ${rig.cols}×${rig.rows} chars`
  setTimeout(() => { copyBtn.textContent = 'copy frame as text' }, 1500)
})

gradBtn.addEventListener('click', () => {
  source = 'gradient'
  gradBtn.hidden = true
  rebuild()
})

// drop a video
window.addEventListener('dragover', (e) => e.preventDefault())
window.addEventListener('drop', (e) => {
  e.preventDefault()
  const file = e.dataTransfer?.files?.[0]
  if (!file || !file.type.startsWith('video/')) return
  const v = document.createElement('video')
  v.src = URL.createObjectURL(file)
  v.muted = true
  v.loop = true
  v.playsInline = true
  v.addEventListener('loadeddata', () => {
    video = v
    source = 'video'
    gradBtn.hidden = false
    rebuild()
    void v.play()
  })
})

window.addEventListener('resize', resize)
resize()
colsVal.textContent = String(cfg.cols)
requestAnimationFrame(tick)
