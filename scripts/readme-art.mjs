// Generates the animated SVGs the README shows, in a light and a dark version.
//
//   node scripts/readme-art.mjs
//
// Same family as the engine READMEs in utilitly-oss. GitHub loads README images
// through <img>, which strips scripts, so the animation is CSS only, and text
// uses system fonts. Each element's resting style is the frame worth showing
// on its own, for reduced motion and for viewers that don't animate.
//
// scripts/readme.test.mjs fails if the files on disk drift from this script.

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const THEMES = {
  light: {
    card: '#f6f7fb', panel: '#ffffff', stroke: '#dcdcea', ink: '#1c1c30', muted: '#6b6b86', faint: '#a6a7bf',
    accent: '#4f46e5', accentSoft: '#e6e5fc', green: '#1a9b4b', greenSoft: '#e3f5ea', red: '#e5484d',
  },
  dark: {
    card: '#11121b', panel: '#181926', stroke: '#2c2d40', ink: '#e8e8f3', muted: '#9a9bb6', faint: '#5d5e7a',
    accent: '#9a9bfb', accentSoft: '#26274a', green: '#3fb950', greenSoft: '#173322', red: '#ff6b6f',
  },
}

const FONT = `ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif`
const MONO = `ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace`

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function svg({ width, height, title, desc, css, body }, t) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">
<title id="title">${esc(title)}</title>
<desc id="desc">${esc(desc)}</desc>
<style>
text { font-family: ${FONT}; fill: ${t.ink}; }
.mono { font-family: ${MONO}; }
.muted { fill: ${t.muted}; }
.faint { fill: ${t.faint}; }
.accent { fill: ${t.accent}; }
.ok { fill: ${t.green}; }
${css.trim()}
@media (prefers-reduced-motion: reduce) { * { animation: none !important; } }
</style>
<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="16" fill="${t.card}" stroke="${t.stroke}"/>
${body.trim()}
</svg>
`
}

/** Fades an element in at `from`% of the loop and keeps it until the loop ends. */
function appear(cls, from, total) {
  return `.${cls} { animation: ${cls} ${total}s ease-out infinite; }
@keyframes ${cls} { 0%, ${from}% { opacity: 0; transform: translateY(4px); } ${from + 3}%, 94% { opacity: 1; transform: translateY(0); } 100% { opacity: 0; transform: translateY(0); } }`
}

function hero(t) {
  const total = 9
  const files = [
    { name: 'march.pdf', note: '', cls: '' },
    { name: 'april.pdf', note: '', cls: '' },
    { name: 'march-merged.pdf', note: 'new', cls: 'f1' },
    { name: 'march-merged-trimmed.pdf', note: 'new', cls: 'f2' },
  ]
  const list = files.map((f, i) => {
    const y = 78 + i * 30
    const row = `<rect x="532" y="${y - 17}" width="272" height="26" rx="6" fill="${f.note ? t.greenSoft : 'none'}"/>
<rect x="542" y="${y - 11}" width="12" height="15" rx="2" fill="${t.panel}" stroke="${t.red}" stroke-width="1.5"/>
<text x="562" y="${y}" font-size="12.5" class="mono">${esc(f.name)}</text>
${f.note ? `<text x="792" y="${y}" font-size="11" text-anchor="end" class="ok" font-weight="600">${f.note}</text>` : ''}`
    return f.cls ? `<g class="${f.cls}">${row}</g>` : row
  }).join('\n')
  return svg({
    width: 840, height: 260,
    title: '@utilitly/mcp',
    desc: 'In an AI chat, someone asks to merge two invoices and remove a blank page. The merge_pdfs and delete_pages tools run on their computer, and the new PDFs appear in the folder next to the untouched originals.',
    css: `
${appear('ask', 2, total)}
${appear('c1', 16, total)}
${appear('f1', 28, total)}
${appear('c2', 38, total)}
${appear('f2', 50, total)}
${appear('done', 60, total)}`,
    body: `<rect x="24" y="24" width="484" height="184" rx="10" fill="${t.panel}" stroke="${t.stroke}"/>
<text x="42" y="47" font-size="12" class="muted">your AI app</text>
<g class="ask"><rect x="150" y="58" width="342" height="44" rx="12" fill="${t.accentSoft}"/>
<text x="164" y="76" font-size="12.5">Merge march.pdf and april.pdf in Documents,</text>
<text x="164" y="93" font-size="12.5">then delete the blank page 3.</text></g>
<g class="c1"><rect x="42" y="114" width="154" height="24" rx="12" fill="${t.card}" stroke="${t.stroke}"/>
<text x="56" y="130" font-size="12" class="mono">merge_pdfs <tspan class="ok">✓</tspan></text></g>
<g class="c2"><rect x="204" y="114" width="164" height="24" rx="12" fill="${t.card}" stroke="${t.stroke}"/>
<text x="218" y="130" font-size="12" class="mono">delete_pages <tspan class="ok">✓</tspan></text></g>
<g class="done"><text x="42" y="164" font-size="12.5">Done. The new file is march-merged-trimmed.pdf,</text>
<text x="42" y="182" font-size="12.5">next to your originals, which weren't changed.</text></g>
<rect x="524" y="24" width="292" height="184" rx="10" fill="${t.panel}" stroke="${t.stroke}"/>
<text x="542" y="47" font-size="12" class="mono muted">~/Documents</text>
${list}
<text x="36" y="238" font-size="14" class="mono">npx -y @utilitly/mcp</text>
<text x="804" y="238" font-size="12.5" text-anchor="end" class="muted">runs on your computer, next to your AI app</text>`,
  }, t)
}

function noNetwork(t) {
  const total = 7
  const tools = ['pdf_info', 'merge_pdfs', 'split_pdf', 'extract_pages', 'rotate_pdf', 'delete_pages', 'reorder_pages', 'duplicate_pages']
  const css = tools.map((_, i) => `.t${i} { animation: t${i} ${total}s steps(1, end) infinite; }
@keyframes t${i} { 0% { opacity: 0; } ${20 + i * 6}% { opacity: 1; } 94% { opacity: 0; } }`).join('\n')
  const rows = tools.map((name, i) => {
    const col = i % 4
    const row = Math.floor(i / 4)
    return `<text x="${48 + col * 186}" y="${122 + row * 24}" font-size="12.5" class="mono t${i}"><tspan class="ok">✓</tspan> ${name}</text>`
  }).join('\n')
  return svg({
    width: 840, height: 232,
    title: '@utilitly/mcp: the no-network test',
    desc: 'A test blocks every way to reach the network, then runs all eight tools. Each one completes and the test passes: no connection was opened.',
    css: `
.cmd { animation: cmd ${total}s steps(1, end) infinite; }
@keyframes cmd { 0% { opacity: 0; } 3% { opacity: 1; } 94% { opacity: 0; } }
.blocked { animation: blocked ${total}s steps(1, end) infinite; }
@keyframes blocked { 0% { opacity: 0; } 12% { opacity: 1; } 94% { opacity: 0; } }
${css}
.passed { animation: passed ${total}s ease-out infinite; }
@keyframes passed { 0%, 70% { opacity: 0; } 74%, 92% { opacity: 1; } 96%, 100% { opacity: 0; } }`,
    body: `<rect x="24" y="24" width="792" height="184" rx="10" fill="${t.panel}" stroke="${t.stroke}"/>
<text x="48" y="62" font-size="13" class="mono cmd">$ npx vitest run test/network.test.ts</text>
<text x="48" y="92" font-size="12.5" class="mono muted blocked">net.Socket.connect, dns.lookup and fetch now throw "network used"</text>
${rows}
<text x="48" y="186" font-size="13" font-weight="700" class="mono passed ok">✓ every tool runs with the network blocked</text>
<text x="792" y="186" font-size="12.5" text-anchor="end" class="mono muted passed">1 passed</text>`,
  }, t)
}

/** Every generated file, as { 'repo/relative/path.svg': contents }. */
export function renderAll() {
  const files = {}
  for (const [theme, t] of Object.entries(THEMES)) {
    files[`assets/hero-${theme}.svg`] = hero(t)
    files[`assets/no-network-${theme}.svg`] = noNetwork(t)
  }
  return files
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const files = renderAll()
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(ROOT, path)), { recursive: true })
    writeFileSync(join(ROOT, path), contents)
  }
  console.log(`Wrote ${Object.keys(files).length} SVGs.`)
}
