// SPDX-License-Identifier: Apache-2.0
import type { PixelSource } from './encode'

// A deterministic drifting plasma - the zero-asset demo source. Pure function
// of (width, height, t): the same t always yields the same frame, so it also
// serves as the fixture for the lossless roundtrip test. No video, no decode,
// no dependencies. Pass a reused `out` buffer to avoid per-frame allocation.
// NOT responsible for: real video decode (that is the browser's <video> in the
// demo). Test strategy: feed fixed t values, assert pack/unpack roundtrip.
export function gradientFrame(width: number, height: number, t: number, out?: Uint8ClampedArray): PixelSource {
  const n = width * height * 4
  const data = out && out.length === n ? out : new Uint8ClampedArray(n)
  for (let y = 0; y < height; y++) {
    const fy = y / height
    for (let x = 0; x < width; x++) {
      const fx = x / width
      const o = (y * width + x) * 4
      data[o] = 128 + 127 * Math.sin((fx * 6 + t) * Math.PI)
      data[o + 1] = 128 + 127 * Math.sin((fy * 6 - t * 0.7) * Math.PI)
      data[o + 2] = 128 + 127 * Math.sin((fx + fy) * 5 * Math.PI + t * 1.3)
      data[o + 3] = 255
    }
  }
  return { data, width, height }
}
