// Renders public/favicon.svg into the PNG icons the PWA manifest needs.
// Usage: node scripts/generate-icons.mjs  (uses the locally available Playwright Chromium)
import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'

// Playwright is resolved via require so a globally installed copy also works.
const { chromium } = createRequire(import.meta.url)('playwright')

const svg = await readFile(new URL('../public/favicon.svg', import.meta.url), 'utf8')
const targets = [
  { file: 'pwa-192.png', size: 192, pad: 0 },
  { file: 'pwa-512.png', size: 512, pad: 0 },
  { file: 'apple-touch-icon.png', size: 180, pad: 0 },
  // Maskable icons need the artwork inside the central 80% safe zone.
  { file: 'pwa-maskable-512.png', size: 512, pad: 0.14 },
]

const browser = await chromium.launch()
const page = await browser.newPage()
for (const { file, size, pad } of targets) {
  await page.setViewportSize({ width: size, height: size })
  const inset = Math.round(size * pad)
  await page.setContent(`<!doctype html><html><body style="margin:0;background:#03050a">
    <div style="width:${size}px;height:${size}px;display:grid;place-items:center">
      <img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}"
           style="width:${size - inset * 2}px;height:${size - inset * 2}px;border-radius:${pad ? 0 : size * 0.22}px"/>
    </div></body></html>`)
  const png = await page.screenshot({ omitBackground: false })
  await writeFile(new URL(`../public/${file}`, import.meta.url), png)
  console.log('wrote', file)
}
await browser.close()
