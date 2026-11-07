// gpt-image 中转生图链路：提交（input_fidelity 降级重试）→ 轮询（8 分钟 deadline）→ 下载落盘。
// 移植自 amazon-ecom-agent 的 server/legacy/image_gen.py（AGPL-3.0）。
// 与原实现的差异：不做 Pillow 画布规范化（exact size 由中转返回的原图为准），保真前言/安全区提示/降级重试全部保留。
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

export class ImageGenError extends Error {}

function parseSize(size) {
  const m = /^(\d+)x(\d+)$/i.exec(String(size || '').trim())
  if (!m) throw new ImageGenError(`size 格式应为 "宽x高"，如 1024x1024，实际：${size}`)
  return { w: Number(m[1]), h: Number(m[2]) }
}

function imageCfgReady(config) {
  if (!config?.imageBaseUrl || !config?.imageApiKey) {
    throw new ImageGenError('生图未配置：插件 → dsh-ecom-agent → Configuration 填入 imageBaseUrl / imageApiKey（需有 gpt-image 权限的中转）')
  }
  return true
}

// ── 保真前言：按产品出场分级锁定参考图里的产品本体（原文保留） ──
export function fidelityPreamble(prompt, refCount, presence = 'supporting', productScale = 0.32) {
  if (!refCount) return prompt
  const accessoryRule = 'Reproduce ONLY the primary product unit. If the reference photo is a bundle shot, IGNORE the loose extras (memory cards, cables, straps, manuals, packaging) — do NOT carry them into this scene. '
  let scaleRule = ''
  if (presence === 'environmental') {
    scaleRule = `In this composition the product intentionally appears SMALL — roughly ${Math.max(5, Math.round(productScale * 100))}% of the frame, naturally placed in a believable real scene. `
  } else if (presence === 'supporting') {
    scaleRule = `The product shares the stage, occupying roughly ${Math.round(productScale * 100)}% of the frame as one element of a designed composition — not a full-frame hero close-up. `
  }
  return (
    'CRITICAL — IMMUTABLE PRODUCT TRUTH: REFERENCE IMAGE 1 shows the EXACT sellable product. '
    + 'Reproduce it identically: same silhouette, geometry, proportions, colors, materials, controls, ports, logos and printed markings. '
    + `${accessoryRule}${scaleRule}`
    + 'Change ONLY the environment, camera, composition, lighting and the exact artwork copy explicitly requested by the prompt. Do NOT redesign, recolor, relabel or simplify the product.\n\n'
  ) + prompt
}

export function providerSizeFor(target) {
  const { w, h } = parseSize(target)
  const ratio = h ? w / h : 1
  if (Math.abs(ratio - 1) < 0.12) return '1024x1024'
  if (ratio >= 1.9) return `${w}x${h}` // 宽幅（A+ 1464×600）直接按目标比例下单——硬套再裁会切标题（踩坑）
  if (ratio > 1) return '1536x1024'
  return '1024x1536'
}

export function cropSafeZoneNote(targetSize, providerSize) {
  const tw = parseSize(targetSize).w, th = parseSize(targetSize).h
  const pw = parseSize(providerSize).w, ph = parseSize(providerSize).h
  const scale = Math.max(tw / pw, th / ph)
  const dispW = pw * scale, dispH = ph * scale
  const cropV = dispH ? (dispH - th) / dispH : 0
  const cropH = dispW ? (dispW - tw) / dispW : 0
  if (Math.max(cropV, cropH) <= 0.10) return ''
  let each, keep, band
  if (cropV >= cropH) {
    each = Math.round((cropV * 100) / 2); keep = 100 - each * 2; band = 'central horizontal band'
  } else {
    each = Math.round((cropH * 100) / 2); keep = 100 - each * 2; band = 'central vertical band'
  }
  return `CANVAS CROP NOTICE: you are painting on a ${pw}×${ph} canvas, but the delivered image is ${tw}×${th} after CENTER-CROPPING — the outer ~${each}% on each side WILL BE CUT OFF. Compose everything essential (headline, product, key elements) inside the ${band} (~${keep}% surviving). Background must extend fully to all edges of the final image.`
}

async function toDataUri(source, dataDir, fetchImpl = fetch) {
  if (source.startsWith('http://') || source.startsWith('https://')) {
    const r = await fetchImpl(source, { signal: AbortSignal.timeout(60_000) })
    if (!r.ok) throw new ImageGenError(`参考图下载失败：HTTP ${r.status}`)
    const buf = Buffer.from(await r.arrayBuffer())
    const mime = /\.jpe?g$/i.test(source.split('?')[0]) ? 'image/jpeg' : 'image/png'
    return `data:${mime};base64,${buf.toString('base64')}`
  }
  let p = source
  if (!/^[A-Za-z]:[\\/]/.test(p) && !p.startsWith('/')) p = join(dataDir, source)
  if (!existsSync(p)) throw new ImageGenError(`参考图不存在: ${source}`)
  const buf = readFileSync(p)
  const mime = /\.jpe?g$/i.test(p) ? 'image/jpeg' : 'image/png'
  return `data:${mime};base64,${buf.toString('base64')}`
}

async function submit(config, prompt, size, refDataUris, fetchImpl = fetch) {
  imageCfgReady(config)
  const providerSize = providerSizeFor(size)
  const note = cropSafeZoneNote(size, providerSize)
  if (note) prompt = `${note}\n\n${prompt}`
  const baseBody = { model: 'gpt-image-2', prompt, n: 1, size: providerSize }
  if (refDataUris.length) baseBody.image_urls = refDataUris.slice(0, 2)

  // input_fidelity:"high" 保住参考图的产品细节；中转可能不认这个字段，降级重试
  const attempts = refDataUris.length ? [{ ...baseBody, input_fidelity: 'high' }, baseBody] : [baseBody]
  let lastText = ''
  for (let idx = 0; idx < attempts.length; idx++) {
    const res = await fetchImpl(`${config.imageBaseUrl.replace(/\/$/, '')}/images/generations`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.imageApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(attempts[idx]),
      signal: AbortSignal.timeout(45_000),
    })
    if (res.status === 200) {
      const data = await res.json()
      const taskId = data?.data?.[0]?.task_id
      if (!taskId) throw new ImageGenError(`生图未返回 task_id: ${JSON.stringify(data).slice(0, 300)}`)
      return String(taskId)
    }
    lastText = await res.text().catch(() => '')
    if (!(idx === 0 && (res.status === 400 || res.status === 422))) break
  }
  throw new ImageGenError(`生图提交失败: ${lastText.slice(0, 300)}`)
}

function parseTaskPayload(payload) {
  const taskData = payload?.data && typeof payload.data === 'object' ? payload.data : {}
  const status = String(taskData.status || 'processing').toLowerCase()
  if (status === 'completed') {
    const result = taskData.result && typeof taskData.result === 'object' ? taskData.result : {}
    const images = Array.isArray(result.images) ? result.images : []
    let url = images.length && typeof images[0] === 'object' ? images[0].url || '' : ''
    if (Array.isArray(url)) url = url[0] || ''
    return url ? { status: 'completed', providerUrl: String(url) } : { status: 'failed', error: '任务完成但未返回图片 URL' }
  }
  if (status === 'failed') {
    const detail = taskData.error || taskData.message || taskData.result || '上游生图任务失败'
    return { status: 'failed', error: String(detail).slice(0, 500) }
  }
  return { status: status || 'processing' }
}

async function poll(config, taskId, { deadlineSeconds = 8 * 60, fetchImpl = fetch } = {}) {
  if (!/^[A-Za-z0-9_-]{6,160}$/.test(taskId)) throw new ImageGenError('无效的生图任务 ID')
  const deadline = Date.now() + deadlineSeconds * 1000
  while (Date.now() < deadline) {
    await sleep(5000)
    let res
    try {
      res = await fetchImpl(`${config.imageBaseUrl.replace(/\/$/, '')}/tasks/${taskId}`, {
        headers: { Authorization: `Bearer ${config.imageApiKey}` },
        signal: AbortSignal.timeout(45_000),
      })
    } catch { continue } // 瞬时网络错误——任务已付费，继续等
    if (res.status === 429 || res.status >= 500) continue
    if (res.status !== 200) throw new ImageGenError(`生图任务查询失败 HTTP ${res.status}: ${(await res.text()).slice(0, 240)}`)
    const state = parseTaskPayload(await res.json())
    if (state.status === 'failed') throw new ImageGenError(state.error || '上游生图任务失败')
    if (state.status !== 'completed') continue
    const dl = await fetchImpl(state.providerUrl, { signal: AbortSignal.timeout(60_000) })
    if (!dl.ok) throw new ImageGenError(`生图结果下载失败：HTTP ${dl.status}`)
    return Buffer.from(await dl.arrayBuffer())
  }
  throw new ImageGenError('生图等待超过 8 分钟（任务未重复提交，可稍后重试）')
}

/** 一次完整生成：可选参考图 → 保真前言 → 提交 → 轮询 → 落盘。返回 {file} */
export async function generateImage(config, prompt, size = '1024x1024', referenceImage = '', presence = 'supporting', fetchImpl = fetch) {
  imageCfgReady(config)
  const refs = referenceImage ? [await toDataUri(referenceImage, config.dataDir, fetchImpl)] : []
  const fullPrompt = fidelityPreamble(prompt, refs.length, presence)
  const taskId = await submit(config, fullPrompt, size, refs, fetchImpl)
  const raw = await poll(config, taskId, { fetchImpl })
  const imagesDir = config.imagesDir
  mkdirSync(imagesDir, { recursive: true })
  const file = join(imagesDir, `gen_${Date.now().toString(16)}${Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0')}.png`)
  writeFileSync(file, raw)
  return { file, size }
}

/** 整套图顺序生成（单张失败不中断）。shots 每项 {name, prompt, size?, presence?, reference_image?} */
export async function generateImageSet(config, shots, defaultReference = '', fetchImpl = fetch) {
  const results = []
  for (const shot of shots.slice(0, 9)) {
    const name = String(shot?.name || `图${results.length + 1}`)
    try {
      const ref = String(shot?.reference_image || defaultReference || '')
      const r = await generateImage(config, String(shot?.prompt || ''), String(shot?.size || '1600x1600'), ref, String(shot?.presence || 'supporting'), fetchImpl)
      results.push({ name, ok: true, ...r })
    } catch (err) {
      results.push({ name, ok: false, error: String(err.message).slice(0, 300) }) // 一张失败不拖垮整套
    }
  }
  return results
}

const TRANSLATE_PROMPT = 'Reproduce this image pixel-perfectly. Keep the exact same layout, product, colors, composition, decorations and all non-text visual elements. The ONLY change: translate all visible text into the target language specified below, matching the original text size, position and style as closely as possible.'

/** 图片翻译：逐像素复现原图，唯一改动是图上文字换成目标语言。 */
export async function translateImage(config, imagePath, targetLanguage, fetchImpl = fetch) {
  imageCfgReady(config)
  const dataUri = await toDataUri(imagePath, config.dataDir, fetchImpl)
  const prompt = `${TRANSLATE_PROMPT} Target language: ${targetLanguage}.`
  const taskId = await submit(config, prompt, '1024x1024', [dataUri], fetchImpl)
  const raw = await poll(config, taskId, { fetchImpl })
  const imagesDir = config.imagesDir
  mkdirSync(imagesDir, { recursive: true })
  const file = join(imagesDir, `trans_${Date.now().toString(16)}.png`)
  writeFileSync(file, raw)
  return { file }
}

/** 列出已生成图片（最近 30 张） */
export function listGeneratedImages(config) {
  const imagesDir = config.imagesDir
  if (!existsSync(imagesDir)) return []
  return readdirByMtime(imagesDir)
    .filter((f) => f.endsWith('.png'))
    .slice(0, 30)
    .map((f) => ({ file: join(imagesDir, f), name: f }))
}

import { readdirSync } from 'node:fs'
import { statSync } from 'node:fs'
function readdirByMtime(dir) {
  try {
    return readdirSync(dir).sort((a, b) => {
      try { return statSync(join(dir, b)).mtimeMs - statSync(join(dir, a)).mtimeMs } catch { return 0 }
    })
  } catch { return [] }
}
