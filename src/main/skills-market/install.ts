import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import AdmZip from 'adm-zip'

import {
  collectOccupiedSkillToolNames,
  previewPackageSkillToolNames,
  validateSkillPackageLayout
} from '@/main/agent/skills/index'
import { marketSkillsInstallRoot } from '@/main/agent/skills/paths'
import { mainLog } from '@/main/logger'
import type { SkillsInstallResult, SkillsMarketCatalogItem } from '@/shared/ipc'

const MAX_ZIP_DOWNLOAD_BYTES = 12 * 1024 * 1024
const MAX_UNCOMPRESSED_BYTES = 40 * 1024 * 1024
const DOWNLOAD_TIMEOUT_MS = 120_000

function assertHttpsZipUrl(url: string): void {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    throw new Error('packageUrl is invalid')
  }
  if (u.protocol !== 'https:') throw new Error('packageUrl must be https')
}

async function downloadHttpsBuffer(url: string): Promise<Buffer> {
  assertHttpsZipUrl(url)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)
  try {
    const res = await fetch(url, { method: 'GET', signal: controller.signal })
    if (!res.ok) throw new Error(`Download failed HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > MAX_ZIP_DOWNLOAD_BYTES) {
      throw new Error(`Zip exceeds ${MAX_ZIP_DOWNLOAD_BYTES} bytes limit`)
    }
    return buf
  } finally {
    clearTimeout(timer)
  }
}

function safeRelativeZipPath(entryName: string): string | null {
  const normalized = entryName.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!normalized) return null
  const segments = normalized.split('/')
  if (segments.some((s) => s === '..' || s === '')) return null
  return normalized
}

async function extractZipSafe(zipBuffer: Buffer, destDir: string): Promise<void> {
  const zip = new AdmZip(zipBuffer)
  const entries = zip.getEntries()
  let uncompressedTotal = 0
  const resolvedDest = path.resolve(destDir)

  for (const entry of entries) {
    if (entry.isDirectory) continue
    const rel = safeRelativeZipPath(entry.entryName)
    if (!rel) {
      throw new Error(`Zip contains illegal path: ${entry.entryName}`)
    }
    const data = entry.getData()
    uncompressedTotal += data.length
    if (uncompressedTotal > MAX_UNCOMPRESSED_BYTES) {
      throw new Error(`Uncompressed size exceeds ${MAX_UNCOMPRESSED_BYTES} bytes`)
    }
    const abs = path.resolve(path.join(resolvedDest, rel))
    const relToDest = path.relative(resolvedDest, abs)
    if (relToDest.startsWith('..') || path.isAbsolute(relToDest)) {
      throw new Error('Zip path escape denied')
    }
    await fs.mkdir(path.dirname(abs), { recursive: true })
    await fs.writeFile(abs, data)
  }
}

export async function installSkillFromMarketItem(
  item: SkillsMarketCatalogItem
): Promise<SkillsInstallResult> {
  const folderId = item.id.trim()
  if (!folderId || folderId !== item.id) {
    return { ok: false, error: '无效的技能 id' }
  }
  const dest = path.join(marketSkillsInstallRoot(), folderId)

  let zipBuf: Buffer
  try {
    zipBuf = await downloadHttpsBuffer(item.packageUrl.trim())
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return { ok: false, error: message }
  }

  if (item.sha256) {
    const hex = createHash('sha256').update(zipBuf).digest('hex').toLowerCase()
    const expected = item.sha256.trim().toLowerCase()
    if (hex !== expected) {
      return { ok: false, error: 'SHA256 校验失败，已中止安装' }
    }
  }

  const tmpRoot = path.join(marketSkillsInstallRoot(), `.tmp-install-${folderId}-${Date.now()}`)
  await fs.mkdir(tmpRoot, { recursive: true })
  let movedToDest = false
  try {
    try {
      await extractZipSafe(zipBuf, tmpRoot)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      return { ok: false, error: message }
    }

    const layout = await validateSkillPackageLayout(tmpRoot)
    if (!layout.ok) {
      return { ok: false, error: layout.error }
    }

    const previewNames = await previewPackageSkillToolNames(tmpRoot)
    if (!previewNames.length) {
      return { ok: false, error: '包内未解析到任何 skill 工具名' }
    }

    const occupied = await collectOccupiedSkillToolNames({ excludeMarketFolderId: folderId })
    const conflicts = previewNames.filter((n) => occupied.has(n))
    if (conflicts.length) {
      return {
        ok: false,
        error: `与现有技能工具名冲突：${conflicts.join(', ')}（请先卸载冲突项或修改包内名称）`
      }
    }

    await fs.rm(dest, { recursive: true, force: true })
    await fs.rename(tmpRoot, dest)
    movedToDest = true
    mainLog.info('[skills-market] 已安装技能包:', folderId)
    return { ok: true }
  } finally {
    if (!movedToDest) {
      await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {})
    }
  }
}
