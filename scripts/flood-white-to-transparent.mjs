/**
 * 将四角连通的近白背景改为透明（适用于圆标外圈白底），不依赖 sharp 的色键 API。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import sharp from 'sharp'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')

/** 与背景连通的像素：min(R,G,B) 需 ≥ 此值；略低于纯白以吃掉抗锯齿浅边，但须低于描边灰度（约 241） */
const FLOOD_MIN_CHANNEL = 246

const targets = [
  'resources/app-icon.png',
  'src/renderer/src/assets/agenxy-logo.png',
  'src/renderer/public/favicon.png',
  'assets/agenxy-icon-hub-polished.png'
]

function floodTransparentRgba(data, width, height) {
  const w = width
  const h = height
  const idx = (x, y) => (y * w + x) * 4

  const inBounds = (x, y) => x >= 0 && x < w && y >= 0 && y < h

  const matches = (x, y) => {
    const i = idx(x, y)
    const r = data[i]
    const g = data[i + 1]
    const b = data[i + 2]
    return Math.min(r, g, b) >= FLOOD_MIN_CHANNEL
  }

  const visited = new Uint8Array(w * h)
  const queue = []
  const seeds = [
    [0, 0],
    [w - 1, 0],
    [0, h - 1],
    [w - 1, h - 1]
  ]
  for (const [sx, sy] of seeds) {
    if (!matches(sx, sy)) continue
    const si = sy * w + sx
    if (visited[si]) continue
    visited[si] = 1
    queue.push(sx, sy)
  }

  while (queue.length) {
    const y = queue.pop()
    const x = queue.pop()
    const neighbors = [
      [x - 1, y],
      [x + 1, y],
      [x, y - 1],
      [x, y + 1]
    ]
    for (const [nx, ny] of neighbors) {
      if (!inBounds(nx, ny)) continue
      const ni = ny * w + nx
      if (visited[ni]) continue
      if (!matches(nx, ny)) continue
      visited[ni] = 1
      queue.push(nx, ny)
    }
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!visited[y * w + x]) continue
      const i = idx(x, y)
      data[i] = 0
      data[i + 1] = 0
      data[i + 2] = 0
      data[i + 3] = 0
    }
  }
}

for (const rel of targets) {
  const filePath = path.join(root, rel)
  if (!fs.existsSync(filePath)) {
    console.warn('skip (missing):', rel)
    continue
  }
  const { data, info } = await sharp(filePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  if (info.channels !== 4) {
    console.warn('skip (need RGBA):', rel)
    continue
  }
  const copy = Buffer.from(data)
  floodTransparentRgba(copy, info.width, info.height)
  await sharp(copy, {
    raw: { width: info.width, height: info.height, channels: 4 }
  })
    .png({ compressionLevel: 9, effort: 10 })
    .toFile(filePath)
  console.log('ok:', rel)
}
