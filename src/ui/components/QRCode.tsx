/** 轻量 QR 码组件 — qrcode-generator（~5KB 零依赖） */
import { useMemo } from 'react'
import qrcode from 'qrcode-generator'

export function QRCode({ text, size = 120, dark = '#E6EDF3', light = 'transparent' }: {
  text: string
  size?: number
  dark?: string
  light?: string
}) {
  const url = useMemo(() => {
    try {
      const qr = qrcode(0, 'M') // type 0 = auto, 纠错级别 M
      qr.addData(text)
      qr.make()
      const count = qr.getModuleCount()
      const cell = Math.max(2, Math.floor(size / (count + 4))) // +4 = quiet zone
      const offset = Math.floor((size - count * cell) / 2)

      // 构建 SVG path
      let path = ''
      for (let y = 0; y < count; y++) {
        for (let x = 0; x < count; x++) {
          if (qr.isDark(y, x)) {
            path += `M${offset + x * cell},${offset + y * cell}h${cell}v${cell}h-${cell}z`
          }
        }
      }
      return `data:image/svg+xml,${encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
        `<rect width="${size}" height="${size}" fill="${light}"/>` +
        `<path d="${path}" fill="${dark}"/>` +
        `</svg>`
      )}`
    } catch {
      return ''
    }
  }, [text, size, dark, light])

  if (!url) return null
  return <img src={url} width={size} height={size} alt="QR Code" style={{ imageRendering: 'pixelated', borderRadius: 6 }} />
}
