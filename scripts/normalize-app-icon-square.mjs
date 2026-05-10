/**
 * 将 app 图标裁为「内容居中 + 正方形」，避免 16:9 类画布在任务栏按方格缩放时图形显小。
 * 输出 512² 主文件，并生成 32² favicon。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import sharp from 'sharp'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')

const SRC = path.join(root, 'resources/app-icon.png')
const OUT_MAIN = path.join(root, 'resources/app-icon.png')
const OUT_LOGO = path.join(root, 'src/renderer/src/assets/agenxy-logo.png')
const OUT_FAV = path.join(root, 'src/renderer/public/favicon.png')
const OUT_ASSET = path.join(root, 'assets/agenxy-icon-hub-polished.png')

const MAIN_SIZE = 512
const FAV_SIZE = 32
const ALPHA_CUTOFF = 24
const PADDING_FRAC = 0.045

function bboxAlpha(data, width, height) {
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const a = data[(y * width + x) * 4 + 3]
      if (a < ALPHA_CUTOFF) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  if (maxX < minX) {
    throw new Error('no visible pixels in app-icon.png')
  }
  return { minX, minY, maxX, maxY }
}

async function buildSquarePng() {
  const { data, info } = await sharp(SRC).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const W = info.width
  const H = info.height
  const { minX, minY, maxX, maxY } = bboxAlpha(data, W, H)
  const cw = maxX - minX + 1
  const ch = maxY - minY + 1
  const pad = Math.max(2, Math.round(Math.max(cw, ch) * PADDING_FRAC))

  let left = Math.max(0, minX - pad)
  let top = Math.max(0, minY - pad)
  let right = Math.min(W - 1, maxX + pad)
  let bottom = Math.min(H - 1, maxY + pad)
  let width = right - left + 1
  let height = bottom - top + 1

  const side = Math.max(width, height)
  const padL = Math.floor((side - width) / 2)
  const padT = Math.floor((side - height) / 2)
  const padR = side - width - padL
  const padB = side - height - padT

  const squared = await sharp(SRC)
    .extract({ left, top, width, height })
    .extend({
      top: padT,
      bottom: padB,
      left: padL,
      right: padR,
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    })
    .resize(MAIN_SIZE, MAIN_SIZE, { kernel: sharp.kernel.lanczos3 })
    .png({ compressionLevel: 9, effort: 10 })
    .toBuffer()

  const favicon = await sharp(squared)
    .resize(FAV_SIZE, FAV_SIZE, { kernel: sharp.kernel.lanczos3 })
    .png({ compressionLevel: 9 })
    .toBuffer()

  await fs.promises.writeFile(OUT_MAIN, squared)
  await fs.promises.mkdir(path.dirname(OUT_LOGO), { recursive: true })
  await fs.promises.writeFile(OUT_LOGO, squared)
  await fs.promises.mkdir(path.dirname(OUT_FAV), { recursive: true })
  await fs.promises.writeFile(OUT_FAV, favicon)
  if (fs.existsSync(path.dirname(OUT_ASSET))) {
    await fs.promises.writeFile(OUT_ASSET, squared)
  }

  console.log('normalized', { from: `${W}x${H}`, crop: `${width}x${height}`, out: `${MAIN_SIZE}x${MAIN_SIZE}` })
}

await buildSquarePng()
