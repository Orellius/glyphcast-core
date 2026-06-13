// SPDX-License-Identifier: Apache-2.0
// glyphcast GPU engine, two paths sharing one canvas/VAO:
// - direct: video frame uploaded as a mipmapped texture, the cell encode
//   (quadrant luma split / halfblock / ascii ramp) computed IN the fragment
//   shader. Zero CPU work and zero readback per frame; fps = video fps.
// - cell-buffer: two cols×rows RGBA8 data textures (fg rgb + glyph idx in
//   alpha; bg rgb) from encodeCells - the renderer for the future wire format.
// Both are ONE draw call = atomic frames (no row tearing).
// Atlas: quadrant glyphs 0-15 as exact fillRect quarters; ascii ramp 16-25.
// NOT responsible for: CPU encoding (encode.ts), control flow (main.ts).
// Test strategy: live browser smoke via window.__gc bench + PSNR vs source.

export const GLYPH_COUNT = 90
const GW = 32
const GH = 60
const RAMP = ' .:-=+*#%@'

const VERT = `#version 300 es
layout(location=0) in vec2 aPos;
out vec2 vUV;
void main() { vUV = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`

const FRAG = `#version 300 es
precision highp float;
uniform sampler2D uFg;
uniform sampler2D uBg;
uniform sampler2D uAtlas;
uniform sampler2D uAtlasOct;
uniform vec2 uGrid;
uniform float uGlyphs;
uniform float uPage;
uniform float uScan;
uniform float uGap;
uniform float uGlow;
uniform float uOled;
uniform vec2 uOledTiles;
uniform float uOledGain;
uniform float uFrame;
uniform float uZoom;
uniform vec2 uCenter;
uniform float uSat;
uniform float uCon;
uniform float uBri;

float atlasA(float gi, vec2 p) {
  return uPage > 0.5
    ? texture(uAtlasOct, vec2((gi + p.x) / 256.0, p.y)).a
    : texture(uAtlas, vec2((gi + p.x) / uGlyphs, p.y)).a;
}

in vec2 vUV;
out vec4 frag;
void main() {
  // zoom-to-reveal: scale around uCenter; past ~6px/tile the LOD resolves
  // cells into emitter triads - leaning into the panel
  vec2 zuv = uCenter + (vec2(vUV.x, 1.0 - vUV.y) - uCenter) / uZoom;
  if (any(lessThan(zuv, vec2(0.0))) || any(greaterThanEqual(zuv, vec2(1.0)))) {
    frag = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  vec2 cell = zuv * uGrid;
  ivec2 ci = ivec2(min(floor(cell), uGrid - 1.0));
  vec4 fg = texelFetch(uFg, ci, 0);
  vec4 bg = texelFetch(uBg, ci, 0);
  float gi = floor(fg.a * 255.0 + 0.5);
  vec2 inCell = fract(cell);

  float a = atlasA(gi, inCell);
  vec3 col = mix(bg.rgb, fg.rgb, a);
  // picture controls: the 2-colors-per-cell encode averages hues inside each
  // cell, which slightly desaturates fine colorful texture - same reason TVs
  // ship a saturation control. Defaults are neutral (1.0).
  col = mix(vec3(dot(col, vec3(0.2126, 0.7152, 0.0722))), col, uSat);
  col = (col - 0.5) * uCon + 0.5;
  col *= uBri;

  if (uOled > 0.5) {
    // emitter emulation: one RGB triad per glyph subpixel, lit by the
    // subpixel's color sampled at tile center; black matrix between.
    // LOD: edges are fwidth-AA'd and the whole pattern dissolves into the
    // plain picture when a tile spans < ~6 device px - drawing sub-pixel
    // emitters is how you get shattered-glass moire, not an OLED.
    vec2 t = inCell * uOledTiles;
    float tilePx = 1.0 / max(fwidth(t.x), 1e-5);
    float show = smoothstep(3.0, 6.0, tilePx);
    if (show > 0.0) {
      vec2 tc = (floor(t) + vec2(0.5)) / uOledTiles;
      vec3 colC = mix(bg.rgb, fg.rgb, atlasA(gi, tc));
      vec2 f2 = fract(t);
      float band = floor(min(f2.x, 0.999) * 3.0);
      vec2 bf = vec2(fract(f2.x * 3.0), f2.y);
      vec2 w = vec2(fwidth(f2.x) * 3.0, fwidth(f2.y));
      vec2 m = smoothstep(vec2(0.10) - w, vec2(0.30) + w, bf)
             * (vec2(1.0) - smoothstep(vec2(0.70) - w, vec2(0.90) + w, bf));
      float v = band < 0.5 ? colC.r : band < 1.5 ? colC.g : colC.b;
      vec3 e = band < 0.5 ? vec3(1.0, 0.13, 0.0) : band < 1.5 ? vec3(0.1, 1.0, 0.15) : vec3(0.05, 0.25, 1.0);
      vec3 emitter = min(e * (v * uOledGain) * (m.x * m.y), vec3(1.0));
      col = mix(col, emitter, show);
    }
    frag = vec4(col, 1.0);
    return;
  }
  // phosphor glow: the cell's lit color bleeds into its unlit area
  col += fg.rgb * (uGlow * 0.45 * (1.0 - a));
  // scanline: darken the seam between cell rows (the TV's line structure)
  col *= 1.0 - uScan * pow(abs(inCell.y - 0.5) * 2.0, 4.0);
  // subpixel gap: thin dark separator between cell columns (OLED grid)
  col *= 1.0 - uGap * pow(abs(inCell.x - 0.5) * 2.0, 8.0);
  // FRC: +-0.5 LSB temporal noise - same trick 8-bit+FRC "10-bit" panels use;
  // breaks residual quantization banding into invisible averaged noise
  float dn = fract(sin(dot(gl_FragCoord.xy + vec2(uFrame * 13.0, uFrame * 7.0), vec2(12.9898, 78.233))) * 43758.5453);
  col += vec3((dn - 0.5) / 255.0);
  frag = vec4(col, 1.0);
}`

const FRAG_DIRECT = `#version 300 es
precision highp float;
uniform sampler2D uVideo;
uniform sampler2D uAtlas;
uniform vec2 uGrid;
uniform float uGlyphs;
uniform float uLod;
uniform int uMode;
uniform float uStep;
uniform float uSharp;
in vec2 vUV;
out vec4 frag;

const vec3 LW = vec3(0.2126, 0.7152, 0.0722);

vec3 tap(vec2 uv) { return textureLod(uVideo, uv, uLod).rgb; }

vec3 sharpTap(vec2 uv, vec2 pitch) {
  vec3 c = tap(uv);
  if (uSharp <= 0.0) return c;
  vec3 n = tap(uv - vec2(pitch.x, 0.0)) + tap(uv + vec2(pitch.x, 0.0))
         + tap(uv - vec2(0.0, pitch.y)) + tap(uv + vec2(0.0, pitch.y));
  return clamp(c * (1.0 + 4.0 * uSharp) - uSharp * n, 0.0, 1.0);
}

vec3 quant(vec3 c) {
  if (uStep <= 0.0) return c;
  return floor(c / uStep) * uStep;
}

void main() {
  vec2 cell = vec2(vUV.x, 1.0 - vUV.y) * uGrid;
  vec2 ci = floor(min(cell, uGrid - 1.0));
  vec2 f = cell - ci;
  vec2 cuv = 1.0 / uGrid;

  if (uMode == 1) {
    vec2 sub = vec2(0.5, f.y < 0.5 ? 0.25 : 0.75);
    frag = vec4(quant(sharpTap((ci + sub) * cuv, cuv * 0.5)), 1.0);
    return;
  }
  if (uMode == 2) {
    vec3 c = textureLod(uVideo, (ci + 0.5) * cuv, uLod + 1.0).rgb;
    float gi = 16.0 + floor(min(dot(c, LW), 0.999) * 10.0);
    float a = texture(uAtlas, vec2((gi + f.x) / uGlyphs, f.y)).a;
    frag = vec4(quant(c) * a, 1.0);
    return;
  }

  if (uMode == 4) {
    vec2 opitch = cuv * vec2(0.5, 0.25);
    vec3 t0 = sharpTap((ci + vec2(0.25, 0.125)) * cuv, opitch);
    vec3 t1 = sharpTap((ci + vec2(0.75, 0.125)) * cuv, opitch);
    vec3 t2 = sharpTap((ci + vec2(0.25, 0.375)) * cuv, opitch);
    vec3 t3 = sharpTap((ci + vec2(0.75, 0.375)) * cuv, opitch);
    vec3 t4 = sharpTap((ci + vec2(0.25, 0.625)) * cuv, opitch);
    vec3 t5 = sharpTap((ci + vec2(0.75, 0.625)) * cuv, opitch);
    vec3 t6 = sharpTap((ci + vec2(0.25, 0.875)) * cuv, opitch);
    vec3 t7 = sharpTap((ci + vec2(0.75, 0.875)) * cuv, opitch);
    float n0 = dot(t0, LW); float n1 = dot(t1, LW); float n2 = dot(t2, LW); float n3 = dot(t3, LW);
    float n4 = dot(t4, LW); float n5 = dot(t5, LW); float n6 = dot(t6, LW); float n7 = dot(t7, LW);
    float oavg = (n0 + n1 + n2 + n3 + n4 + n5 + n6 + n7) * 0.125;
    bool p0 = n0 > oavg; bool p1 = n1 > oavg; bool p2 = n2 > oavg; bool p3 = n3 > oavg;
    bool p4 = n4 > oavg; bool p5 = n5 > oavg; bool p6 = n6 > oavg; bool p7 = n7 > oavg;
    vec3 fgO = vec3(0.0); float fno = 0.0;
    vec3 bgO = vec3(0.0); float bno = 0.0;
    if (p0) { fgO += t0; fno += 1.0; } else { bgO += t0; bno += 1.0; }
    if (p1) { fgO += t1; fno += 1.0; } else { bgO += t1; bno += 1.0; }
    if (p2) { fgO += t2; fno += 1.0; } else { bgO += t2; bno += 1.0; }
    if (p3) { fgO += t3; fno += 1.0; } else { bgO += t3; bno += 1.0; }
    if (p4) { fgO += t4; fno += 1.0; } else { bgO += t4; bno += 1.0; }
    if (p5) { fgO += t5; fno += 1.0; } else { bgO += t5; bno += 1.0; }
    if (p6) { fgO += t6; fno += 1.0; } else { bgO += t6; bno += 1.0; }
    if (p7) { fgO += t7; fno += 1.0; } else { bgO += t7; bno += 1.0; }
    vec3 obg = bno > 0.0 ? bgO / bno : fgO / max(fno, 1.0);
    vec3 ofg = fno > 0.0 ? fgO / fno : obg;
    int orow = int(min(f.y * 4.0, 3.0));
    bool oleft = f.x < 0.5;
    bool oOn = orow == 0 ? (oleft ? p0 : p1) : orow == 1 ? (oleft ? p2 : p3) : orow == 2 ? (oleft ? p4 : p5) : (oleft ? p6 : p7);
    frag = vec4(quant(oOn ? ofg : obg), 1.0);
    return;
  }

  if (uMode == 3) {
    vec2 spitch = cuv * vec2(0.5, 0.3333333);
    vec3 s0 = sharpTap((ci + vec2(0.25, 0.1666667)) * cuv, spitch);
    vec3 s1 = sharpTap((ci + vec2(0.75, 0.1666667)) * cuv, spitch);
    vec3 s2 = sharpTap((ci + vec2(0.25, 0.5)) * cuv, spitch);
    vec3 s3 = sharpTap((ci + vec2(0.75, 0.5)) * cuv, spitch);
    vec3 s4 = sharpTap((ci + vec2(0.25, 0.8333333)) * cuv, spitch);
    vec3 s5 = sharpTap((ci + vec2(0.75, 0.8333333)) * cuv, spitch);
    float m0 = dot(s0, LW); float m1 = dot(s1, LW); float m2 = dot(s2, LW);
    float m3 = dot(s3, LW); float m4 = dot(s4, LW); float m5 = dot(s5, LW);
    float savg = (m0 + m1 + m2 + m3 + m4 + m5) / 6.0;
    bool o0 = m0 > savg; bool o1 = m1 > savg; bool o2 = m2 > savg;
    bool o3 = m3 > savg; bool o4 = m4 > savg; bool o5 = m5 > savg;
    vec3 fgS = vec3(0.0); float fn = 0.0;
    vec3 bgS = vec3(0.0); float bn = 0.0;
    if (o0) { fgS += s0; fn += 1.0; } else { bgS += s0; bn += 1.0; }
    if (o1) { fgS += s1; fn += 1.0; } else { bgS += s1; bn += 1.0; }
    if (o2) { fgS += s2; fn += 1.0; } else { bgS += s2; bn += 1.0; }
    if (o3) { fgS += s3; fn += 1.0; } else { bgS += s3; bn += 1.0; }
    if (o4) { fgS += s4; fn += 1.0; } else { bgS += s4; bn += 1.0; }
    if (o5) { fgS += s5; fn += 1.0; } else { bgS += s5; bn += 1.0; }
    vec3 sbg = bn > 0.0 ? bgS / bn : fgS / max(fn, 1.0);
    vec3 sfg = fn > 0.0 ? fgS / fn : sbg;
    int srow = int(min(f.y * 3.0, 2.0));
    bool left = f.x < 0.5;
    bool sOn = srow == 0 ? (left ? o0 : o1) : srow == 1 ? (left ? o2 : o3) : (left ? o4 : o5);
    frag = vec4(quant(sOn ? sfg : sbg), 1.0);
    return;
  }

  vec2 pitch = cuv * 0.5;
  vec3 c00 = sharpTap((ci + vec2(0.25, 0.25)) * cuv, pitch);
  vec3 c10 = sharpTap((ci + vec2(0.75, 0.25)) * cuv, pitch);
  vec3 c01 = sharpTap((ci + vec2(0.25, 0.75)) * cuv, pitch);
  vec3 c11 = sharpTap((ci + vec2(0.75, 0.75)) * cuv, pitch);
  vec4 l = vec4(dot(c00, LW), dot(c10, LW), dot(c01, LW), dot(c11, LW));
  float avg = (l.x + l.y + l.z + l.w) * 0.25;
  bvec4 on = greaterThan(l, vec4(avg));
  vec3 fgSum = vec3(0.0); float fn = 0.0;
  vec3 bgSum = vec3(0.0); float bn = 0.0;
  if (on.x) { fgSum += c00; fn += 1.0; } else { bgSum += c00; bn += 1.0; }
  if (on.y) { fgSum += c10; fn += 1.0; } else { bgSum += c10; bn += 1.0; }
  if (on.z) { fgSum += c01; fn += 1.0; } else { bgSum += c01; bn += 1.0; }
  if (on.w) { fgSum += c11; fn += 1.0; } else { bgSum += c11; bn += 1.0; }
  vec3 bg = bn > 0.0 ? bgSum / bn : fgSum / max(fn, 1.0);
  vec3 fg = fn > 0.0 ? fgSum / fn : bg;
  bool isOn = f.x < 0.5 ? (f.y < 0.5 ? on.x : on.z) : (f.y < 0.5 ? on.y : on.w);
  frag = vec4(quant(isOn ? fg : bg), 1.0);
}`

function buildAtlas(): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = GLYPH_COUNT * GW
  c.height = GH
  const x = c.getContext('2d')!
  x.fillStyle = '#fff'
  for (let i = 0; i < 16; i++) {
    const ox = i * GW
    if (i & 1) x.fillRect(ox, 0, GW / 2, GH / 2)
    if (i & 2) x.fillRect(ox + GW / 2, 0, GW / 2, GH / 2)
    if (i & 4) x.fillRect(ox, GH / 2, GW / 2, GH / 2)
    if (i & 8) x.fillRect(ox + GW / 2, GH / 2, GW / 2, GH / 2)
  }
  x.font = `${Math.round(GH * 0.82)}px Menlo, Consolas, monospace`
  x.textAlign = 'center'
  x.textBaseline = 'middle'
  for (let i = 0; i < RAMP.length; i++) x.fillText(RAMP[i], (16 + i) * GW + GW / 2, GH / 2)
  // sextants 26-89 as exact rect sixths - no font dependency, seamless
  const TH = GH / 3
  for (let b = 0; b < 64; b++) {
    const ox = (26 + b) * GW
    for (let s = 0; s < 6; s++) {
      if (b & (1 << s)) x.fillRect(ox + (s & 1) * (GW / 2), (s >> 1) * TH, GW / 2, TH)
    }
  }
  return c
}

// octants get their own 256-glyph page (mask-indexed) - the base atlas's
// 8-bit glyph index space is full
function buildOctantAtlas(): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = 256 * GW
  c.height = GH
  const x = c.getContext('2d')!
  x.fillStyle = '#fff'
  const QH = GH / 4
  for (let b = 0; b < 256; b++) {
    const ox = b * GW
    for (let s = 0; s < 8; s++) {
      if (b & (1 << s)) x.fillRect(ox + (s & 1) * (GW / 2), (s >> 1) * QH, GW / 2, QH)
    }
  }
  return c
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!
  gl.shaderSource(sh, src)
  gl.compileShader(sh)
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) ?? 'shader compile failed')
  return sh
}

export function createRendererGL(canvas: HTMLCanvasElement, opts: { p3?: boolean } = {}) {
  const gl = canvas.getContext('webgl2', { premultipliedAlpha: false, antialias: false })
  if (!gl) throw new Error('webgl2 unavailable')
  if (opts.p3 && 'drawingBufferColorSpace' in gl) gl.drawingBufferColorSpace = 'display-p3'

  const prog = gl.createProgram()!
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT))
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG))
  gl.linkProgram(prog)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? 'link failed')
  gl.useProgram(prog)

  const vao = gl.createVertexArray()
  gl.bindVertexArray(vao)
  const vbo = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
  gl.enableVertexAttribArray(0)
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)

  const newTex = (unit: number) => {
    const t = gl.createTexture()!
    gl.activeTexture(gl.TEXTURE0 + unit)
    gl.bindTexture(gl.TEXTURE_2D, t)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    return t
  }

  newTex(0)
  newTex(1)
  newTex(2)
  gl.activeTexture(gl.TEXTURE2)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, buildAtlas())
  newTex(4)
  gl.activeTexture(gl.TEXTURE4)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, buildOctantAtlas())

  gl.uniform1i(gl.getUniformLocation(prog, 'uFg'), 0)
  gl.uniform1i(gl.getUniformLocation(prog, 'uBg'), 1)
  gl.uniform1i(gl.getUniformLocation(prog, 'uAtlas'), 2)
  gl.uniform1i(gl.getUniformLocation(prog, 'uAtlasOct'), 4)
  gl.uniform1f(gl.getUniformLocation(prog, 'uGlyphs'), GLYPH_COUNT)
  const uPage = gl.getUniformLocation(prog, 'uPage')
  const uGrid = gl.getUniformLocation(prog, 'uGrid')
  const uScan = gl.getUniformLocation(prog, 'uScan')
  const uGap = gl.getUniformLocation(prog, 'uGap')
  const uGlow = gl.getUniformLocation(prog, 'uGlow')
  const uOled = gl.getUniformLocation(prog, 'uOled')
  const uOledTiles = gl.getUniformLocation(prog, 'uOledTiles')
  const uOledGain = gl.getUniformLocation(prog, 'uOledGain')
  const uFrame = gl.getUniformLocation(prog, 'uFrame')
  const uZoom = gl.getUniformLocation(prog, 'uZoom')
  const uCenter = gl.getUniformLocation(prog, 'uCenter')
  gl.uniform1f(uZoom, 1)
  gl.uniform2f(uCenter, 0.5, 0.5)
  const uSat = gl.getUniformLocation(prog, 'uSat')
  const uCon = gl.getUniformLocation(prog, 'uCon')
  const uBri = gl.getUniformLocation(prog, 'uBri')
  gl.uniform1f(uSat, 1)
  gl.uniform1f(uCon, 1)
  gl.uniform1f(uBri, 1)
  let frameNo = 0

  const progD = gl.createProgram()!
  gl.attachShader(progD, compile(gl, gl.VERTEX_SHADER, VERT))
  gl.attachShader(progD, compile(gl, gl.FRAGMENT_SHADER, FRAG_DIRECT))
  gl.linkProgram(progD)
  if (!gl.getProgramParameter(progD, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(progD) ?? 'direct link failed')
  gl.useProgram(progD)
  gl.uniform1i(gl.getUniformLocation(progD, 'uVideo'), 3)
  gl.uniform1i(gl.getUniformLocation(progD, 'uAtlas'), 2)
  gl.uniform1f(gl.getUniformLocation(progD, 'uGlyphs'), GLYPH_COUNT)
  const dGrid = gl.getUniformLocation(progD, 'uGrid')
  const dLod = gl.getUniformLocation(progD, 'uLod')
  const dMode = gl.getUniformLocation(progD, 'uMode')
  const dStep = gl.getUniformLocation(progD, 'uStep')
  const dSharp = gl.getUniformLocation(progD, 'uSharp')

  const videoTex = newTex(3)
  gl.activeTexture(gl.TEXTURE3)
  gl.bindTexture(gl.TEXTURE_2D, videoTex)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)

  let texCols = 0
  let texRows = 0
  let vidW = 0
  let vidH = 0
  const MODE_IDX = { quadrant: 0, halfblock: 1, ascii: 2, sextant: 3, octant: 4 } as const

  return {
    setFx(scan: number, gap: number, glow: number) {
      gl.useProgram(prog)
      gl.uniform1f(uScan, scan)
      gl.uniform1f(uGap, gap)
      gl.uniform1f(uGlow, glow)
    },
    setPicture(sat: number, con: number, bri: number) {
      gl.useProgram(prog)
      gl.uniform1f(uSat, sat)
      gl.uniform1f(uCon, con)
      gl.uniform1f(uBri, bri)
    },
    setZoom(zoom: number, cx: number, cy: number) {
      gl.useProgram(prog)
      gl.uniform1f(uZoom, zoom)
      gl.uniform2f(uCenter, cx, cy)
    },
    setOled(on: boolean, tilesX: number, tilesY: number, gain: number) {
      gl.useProgram(prog)
      gl.uniform1f(uOled, on ? 1 : 0)
      gl.uniform2f(uOledTiles, tilesX, tilesY)
      gl.uniform1f(uOledGain, gain)
    },
    resize(cssW: number, cssH: number) {
      const dpr = window.devicePixelRatio || 1
      canvas.width = Math.round(cssW * dpr)
      canvas.height = Math.round(cssH * dpr)
      canvas.style.width = `${cssW}px`
      canvas.style.height = `${cssH}px`
      gl.viewport(0, 0, canvas.width, canvas.height)
    },
    render(fg: Uint8Array, bg: Uint8Array, cols: number, rows: number, octantPage = false) {
      gl.useProgram(prog)
      gl.uniform1f(uPage, octantPage ? 1 : 0)
      gl.uniform1f(uFrame, (frameNo = (frameNo + 1) % 240))
      if (cols !== texCols || rows !== texRows) {
        texCols = cols
        texRows = rows
        gl.activeTexture(gl.TEXTURE0)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, cols, rows, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
        gl.activeTexture(gl.TEXTURE1)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, cols, rows, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
        gl.uniform2f(uGrid, cols, rows)
      }
      gl.activeTexture(gl.TEXTURE0)
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, cols, rows, gl.RGBA, gl.UNSIGNED_BYTE, fg)
      gl.activeTexture(gl.TEXTURE1)
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, cols, rows, gl.RGBA, gl.UNSIGNED_BYTE, bg)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    },
    renderDirect(video: HTMLVideoElement | HTMLImageElement, cols: number, rows: number, mode: keyof typeof MODE_IDX, qShift: number, sharp: number) {
      gl.useProgram(progD)
      gl.activeTexture(gl.TEXTURE3)
      const sw = video instanceof HTMLVideoElement ? video.videoWidth : video.naturalWidth
      const sh = video instanceof HTMLVideoElement ? video.videoHeight : video.naturalHeight
      if (sw !== vidW || sh !== vidH) {
        vidW = sw
        vidH = sh
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video)
      } else {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, video)
      }
      gl.generateMipmap(gl.TEXTURE_2D)
      gl.uniform2f(dGrid, cols, rows)
      gl.uniform1f(dLod, Math.max(Math.log2(Math.max(vidW / (cols * 2), vidH / (rows * 2))) - 1, 0))
      gl.uniform1i(dMode, MODE_IDX[mode])
      gl.uniform1f(dStep, qShift > 0 ? (1 << qShift) / 255 : 0)
      gl.uniform1f(dSharp, sharp)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    },
    finish() {
      gl.finish()
    },
  }
}
