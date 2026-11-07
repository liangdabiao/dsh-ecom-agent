// Amazon 商品页采集：三级链（curl+cookie jar → 本机浏览器 --dump-dom → Sorftime 兜底）。
// 移植自 amazon-ecom-agent 的 server/legacy/amazon_scrape.py（AGPL-3.0）。
// 原实现的踩坑经验原样保留：最小化请求头、cookie jar 跨重试、一次性浏览器 profile。
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { setTimeout as sleep } from 'node:timers/promises'

const execFileAsync = promisify(execFile)
const REAL_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

const MKT_DOMAIN = {
  US: 'amazon.com', UK: 'amazon.co.uk', DE: 'amazon.de', JP: 'amazon.co.jp',
  FR: 'amazon.fr', IT: 'amazon.it', ES: 'amazon.es', CA: 'amazon.ca',
  AU: 'amazon.com.au', MX: 'amazon.com.mx', IN: 'amazon.in', NL: 'amazon.nl',
  SE: 'amazon.se', PL: 'amazon.pl', AE: 'amazon.ae', SG: 'amazon.sg',
}

export function amazonDomain(marketplace) {
  return MKT_DOMAIN[(marketplace || 'US').toUpperCase()] || 'amazon.com'
}

const MEDIA_RE = /^(https?:\/\/.+\/images\/I\/)([A-Za-z0-9_+%-]+?)(?:\._[^./]*)?\.(jpg|jpeg|png)$/i

function mediaKey(url) {
  const m = MEDIA_RE.exec(url.split('?')[0])
  return m ? m[2] : url
}

function hiresUrl(url) {
  const m = MEDIA_RE.exec(url.split('?')[0])
  return m ? `${m[1]}${m[2]}.${m[3]}` : url
}

function decodeHtml(text) {
  return text
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
}

export function parseAmazonHtml(htmlText) {
  const images = []
  const seen = new Set()
  for (const pat of [/"hiRes"\s*:\s*"(https?:\/\/[^"\\]+)"/g, /"large"\s*:\s*"(https?:\/\/[^"\\]+)"/g]) {
    if (images.length) break
    for (const m of htmlText.matchAll(pat)) {
      const u = m[1]
      const key = mediaKey(u)
      if (!seen.has(key)) { seen.add(key); images.push(u) }
      if (images.length >= 7) break
    }
  }
  if (!images.length) {
    for (const m of htmlText.matchAll(/data-a-dynamic-image="([^"]*)"/g)) {
      const blob = decodeHtml(m[1])
      for (const um of blob.matchAll(/"(https?:\/\/[^"]+)"\s*:\s*\[\s*(\d+)\s*,\s*(\d+)\s*\]/g)) {
        if (Math.min(Number(um[2]), Number(um[3])) < 500) continue // 图标/色块
        const full = hiresUrl(um[1])
        const key = mediaKey(full)
        if (!seen.has(key)) { seen.add(key); images.push(full) }
        if (images.length >= 7) break
      }
      if (images.length >= 7) break
    }
  }
  if (!images.length) {
    const m = htmlText.match(/id="landingImage"[^>]*data-old-hires="(https?:\/\/[^"]+)"/)
      || htmlText.match(/id="landingImage"[^>]*src="(https?:\/\/[^"]+)"/)
    if (m) images.push(m[1])
  }

  const tm = htmlText.match(/id="productTitle"[^>]*>([\s\S]*?)</)
  const title = tm ? decodeHtml(tm[1].replace(/\s+/g, ' ').trim()) : ''

  const bullets = []
  const fb = htmlText.match(/id="feature-bullets"([\s\S]*?)<\/ul>/)
  if (fb) {
    for (const bm of fb[1].matchAll(/class="a-list-item[^"]*"[^>]*>([\s\S]*?)<\/span>/g)) {
      const t = decodeHtml(bm[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim())
      if (t && !bullets.includes(t)) bullets.push(t)
    }
  }
  return { title, bullets: bullets.slice(0, 5), description: '', imageUrls: images }
}

export function isBlocked(htmlText) {
  return htmlText.length < 50_000
    || /Type the characters you see in this image/i.test(htmlText)
    || /we just need to make sure you're not a robot/i.test(htmlText)
}

/** 找本机 Chromium 系浏览器（Windows 自带 Edge 等于零安装） */
export function browserBin() {
  const candidates = []
  const pf = process.env['ProgramFiles'] || 'C:\\Program Files'
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
  const local = process.env.LOCALAPPDATA || ''
  for (const root of [pf, pf86, local]) {
    if (!root) continue
    candidates.push(join(root, 'Google/Chrome/Application/chrome.exe'))
    candidates.push(join(root, 'Microsoft/Edge/Application/msedge.exe'))
  }
  for (const c of candidates) {
    try { if (existsSync(c)) return c } catch { continue }
  }
  return null
}

async function runCurl(args, timeoutMs = 30_000) {
  try {
    const { stdout } = await execFileAsync('curl', args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true })
    return stdout || ''
  } catch (err) {
    return err.stdout || ''
  }
}

/** 一级：curl 直连 + cookie jar 跨重试（关键经验：请求最小化，只有 UA） */
async function scrapeNative(asin, marketplace, attempts = 5) {
  const url = `https://www.${amazonDomain(marketplace)}/dp/${asin}`
  const jar = join(mkdtempSync(join(tmpdir(), 'ecom_ck_')), 'jar.txt')
  try {
    for (let i = 0; i < attempts; i++) {
      const htmlText = await runCurl(['-sS', '-L', '--max-time', '25', '--compressed', '-A', REAL_UA, '-c', jar, '-b', jar, url])
      if (htmlText && !isBlocked(htmlText)) {
        const parsed = parseAmazonHtml(htmlText)
        if (parsed.imageUrls.length) return { ...parsed, scrape_source: 'native' }
      }
      if (i < attempts - 1) await sleep(2000)
    }
    return null
  } finally {
    try { rmSync(jar, { force: true }) } catch { /* 旁路 */ }
  }
}

/** 二级：本机浏览器 --dump-dom 渲染兜底（一次性 profile，绝不碰用户真实会话） */
async function scrapeBrowser(asin, marketplace) {
  const browser = browserBin()
  if (!browser) return null
  const url = `https://www.${amazonDomain(marketplace)}/dp/${asin}`
  const profile = mkdtempSync(join(tmpdir(), 'ecom_cdp_'))
  const args = [browser, '--headless=new', '--disable-gpu', '--disable-extensions',
    '--disable-background-networking', '--no-first-run', '--no-default-browser-check', '--mute-audio',
    `--user-data-dir=${profile}`, '--window-size=1280,2400', '--virtual-time-budget=15000',
    `--user-agent=${REAL_UA}`, '--dump-dom', url]
  try {
    const { stdout } = await execFileAsync(browser, args, { timeout: 90_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true })
    const dom = stdout || ''
    const blocked = /Type the characters you see in this image/i.test(dom)
      || /we just need to make sure you're not a robot/i.test(dom)
    const parsed = blocked ? {} : parseAmazonHtml(dom)
    return parsed.imageUrls?.length ? { ...parsed, scrape_source: 'browser' } : null
  } catch {
    return null
  } finally {
    try { rmSync(profile, { recursive: true, force: true }) } catch { /* 旁路 */ }
  }
}

/** 三级：Sorftime product_detail 兜底（只有 1 张白底主图）。无 key 静默跳过。 */
async function scrapeSorftimeFallback(config, asin, marketplace) {
  if (!config?.sorftimeKey) return null
  try {
    const sorftime = await import('./market/sorftime.js')
    const m = (marketplace || 'US').toUpperCase()
    const { data } = await sorftime.quickCalls(config, [['product_detail', { asin, amz_site: m }]])
    const rec = sorftime.record(data.product_detail)
    const out = {}
    if (rec.title) out.title = String(rec.title).trim()
    if (rec.main_image) out.imageUrls = [String(rec.main_image).trim()]
    const desc = String(rec.description || '').trim()
    if (desc) {
      const parts = desc.split(/<br>|\n/).map((p) => p.trim()).filter(Boolean)
      if (parts.length) { out.bullets = parts.slice(0, 5); out.description = desc }
    }
    return out.title || out.imageUrls ? { ...out, scrape_source: 'sorftime' } : null
  } catch {
    return null
  }
}

/** 三级采集链主入口 */
export async function scrapeProduct(config, asin, marketplace = 'US') {
  let data = await scrapeNative(asin, marketplace)
  if (!data) data = await scrapeBrowser(asin, marketplace)
  if (!data) data = await scrapeSorftimeFallback(config, asin, marketplace)
  return data
}

/** 下载主图到 imagesDir/<asin>/img_i.jpg（作为生图参考图） */
export async function downloadImages(config, imageUrls, asin) {
  const dir = join(config.imagesDir, asin)
  mkdirSync(dir, { recursive: true })
  const local = []
  let i = 0
  for (const url of imageUrls.slice(0, 7)) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) })
      if (!res.ok) continue
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length < 10_000) continue
      i++
      const file = join(dir, `img_${i}.jpg`)
      writeFileSync(file, buf)
      local.push(file)
    } catch { /* 单张失败不中断 */ }
  }
  return local
}
