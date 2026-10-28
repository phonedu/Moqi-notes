/**
 * 极简 PNG 解码（只服务**渲染产物层**判据：截图 → 像素）。
 *
 * 为什么自带解码器：视觉判据（`visual-smoke.mjs` / 真机读数）要读**画出来的像素**——
 * 声明值、DOM、几何都够不到「光标画没画出来」「灰带出没出」。仓库里没有图像库依赖，
 * 而 Node 自带 `zlib` 就足够解 PNG：签名 → IHDR → IDAT（inflate）→ 逐行反滤波。
 *
 * 支持面（刻意收窄）：bitDepth 8、非隔行、colorType 0/2/4/6（灰 / RGB / 灰A / RGBA）。
 * Playwright / CDP 截图默认就是 8bit RGBA 非隔行；遇到不支持的类型**显式抛错**，
 * 不静默返回错像素（宁可红，不许骗）。
 */
import { inflateSync } from 'node:zlib'

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** @returns {{ width:number, height:number, channels:number, data:Buffer }} data = 逐像素 RGBA（通道不足补 255） */
export function decodePng(buffer) {
  if (!buffer.subarray(0, 8).equals(SIGNATURE)) throw new Error('不是 PNG（签名不符）')
  let offset = 8
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0
  const idat = []
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const body = buffer.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      bitDepth = body[8]
      colorType = body[9]
      interlace = body[12]
    } else if (type === 'IDAT') idat.push(body)
    else if (type === 'IEND') break
    offset += 12 + length
  }
  if (bitDepth !== 8) throw new Error(`PNG bitDepth=${bitDepth} 不支持（只解 8bit）`)
  if (interlace !== 0) throw new Error('PNG 隔行不支持')
  const srcChannels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType]
  if (!srcChannels) throw new Error(`PNG colorType=${colorType} 不支持`)
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * srcChannels
  const out = Buffer.alloc(width * height * 4)
  const prior = Buffer.alloc(stride)
  const line = Buffer.alloc(stride)
  let pos = 0
  for (let y = 0; y < height; y += 1) {
    const filter = raw[pos]
    pos += 1
    raw.copy(line, 0, pos, pos + stride)
    pos += stride
    unfilter(filter, line, prior, srcChannels, stride)
    for (let x = 0; x < width; x += 1) {
      const s = x * srcChannels
      const d = (y * width + x) * 4
      if (srcChannels === 1) { out[d] = out[d + 1] = out[d + 2] = line[s]; out[d + 3] = 255 }
      else if (srcChannels === 2) { out[d] = out[d + 1] = out[d + 2] = line[s]; out[d + 3] = line[s + 1] }
      else if (srcChannels === 3) { out[d] = line[s]; out[d + 1] = line[s + 1]; out[d + 2] = line[s + 2]; out[d + 3] = 255 }
      else { out[d] = line[s]; out[d + 1] = line[s + 1]; out[d + 2] = line[s + 2]; out[d + 3] = line[s + 3] }
    }
    line.copy(prior)
  }
  return { width, height, channels: 4, data: out }
}

function unfilter(filter, line, prior, bpp, stride) {
  for (let i = 0; i < stride; i += 1) {
    const a = i >= bpp ? line[i - bpp] : 0
    const b = prior[i]
    const c = i >= bpp ? prior[i - bpp] : 0
    if (filter === 0) continue
    else if (filter === 1) line[i] = (line[i] + a) & 0xff
    else if (filter === 2) line[i] = (line[i] + b) & 0xff
    else if (filter === 3) line[i] = (line[i] + ((a + b) >> 1)) & 0xff
    else if (filter === 4) {
      const p = a + b - c
      const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
      const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      line[i] = (line[i] + pred) & 0xff
    } else throw new Error(`PNG 滤波类型 ${filter} 未知`)
  }
}

export const pixelAt = (img, x, y) => {
  const d = (y * img.width + x) * 4
  return [img.data[d], img.data[d + 1], img.data[d + 2], img.data[d + 3]]
}

/** 感知亮度（0–255），忽略 alpha（判据只用在**不透明**面上）。 */
export const lum = (rgb) => 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]

/** 一行像素的平均亮度（x0..x1-1）。 */
export const rowMeanLum = (img, y, x0 = 0, x1 = img.width) => {
  let sum = 0
  for (let x = x0; x < x1; x += 1) sum += lum(pixelAt(img, x, y))
  return sum / Math.max(1, x1 - x0)
}

/** 一列像素的平均亮度（y0..y1-1）。 */
export const colMeanLum = (img, x, y0 = 0, y1 = img.height) => {
  let sum = 0
  for (let y = y0; y < y1; y += 1) sum += lum(pixelAt(img, x, y))
  return sum / Math.max(1, y1 - y0)
}

/** 一行里满足 `near(target, tol)` 的像素数。 */
export const countRowNear = (img, y, target, tol, x0 = 0, x1 = img.width) => {
  let n = 0
  for (let x = x0; x < x1; x += 1) {
    const [r, g, b] = pixelAt(img, x, y)
    if (Math.abs(r - target[0]) <= tol && Math.abs(g - target[1]) <= tol && Math.abs(b - target[2]) <= tol) n += 1
  }
  return n
}

/** `#rrggbb` / `rgb(...)` / `rgba(...)` → [r, g, b, a]（a 缺省 1）。 */
export const parseColor = (value) => {
  const text = String(value).trim()
  const hex = text.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)
  if (hex) {
    const v = hex[1].length === 3 ? hex[1].split('').map((c) => c + c).join('') : hex[1]
    return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16), 1]
  }
  const m = text.match(/rgba?\(([^)]+)\)/i)
  if (!m) throw new Error(`解不了的色值：${text}`)
  const parts = m[1].split(',').map((x) => Number.parseFloat(x))
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, parts[3] ?? 1]
}
