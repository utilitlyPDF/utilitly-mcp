// Real-install check: stages @utilitly/mcp exactly as it will be published
// (see release-manifest.mjs), lints it, packs it next to the six engine
// packages from ../utilitly-oss, installs everything into a brand-new project,
// then starts the installed command and drives every tool over stdio.
//
//   npm run smoke

import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PDFDocument } from 'pdf-lib'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { releaseManifest } from './release-manifest.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const work = mkdtempSync(join(tmpdir(), 'utilitly-mcp-smoke-'))
let failed = false
const report = (ok, line) => {
  failed ||= !ok
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${line}`)
}

async function samplePdf(pages) {
  const doc = await PDFDocument.create()
  for (let n = 1; n <= pages; n++) doc.addPage([600 + n, 800])
  return doc.save()
}

const order = async file => (await PDFDocument.load(readFileSync(file))).getPages().map(p => Math.round(p.getWidth()) - 600)

try {
  // 1. The package exactly as it will be published.
  const manifest = releaseManifest()
  const stage = join(work, 'stage')
  mkdirSync(stage)
  for (const entry of ['dist', 'README.md', 'LICENSE']) {
    if (existsSync(join(ROOT, entry))) cpSync(join(ROOT, entry), join(stage, entry), { recursive: true })
  }
  writeFileSync(join(stage, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  run(process.execPath, [join(ROOT, 'node_modules', 'publint', 'src', 'cli.js'), '--strict', stage])
  report(true, 'publint --strict on the published form of package.json')

  // Every module the built server imports must be a published dependency.
  const declared = Object.keys(manifest.dependencies)
  const IMPORTS = /\bimport\s+(?:[^'"]*?\sfrom\s+)?["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)|\brequire\(\s*["']([^"']+)["']\s*\)/g
  const used = [...readFileSync(join(stage, 'dist', 'index.mjs'), 'utf8').matchAll(IMPORTS)]
    .map(m => m[1] ?? m[2] ?? m[3])
    .filter(spec => !spec.startsWith('.'))
    .filter(spec => !spec.startsWith('node:'))
    .map(spec => spec.split('/').slice(0, spec.startsWith('@') ? 2 : 1).join('/'))
  const undeclared = [...new Set(used)].filter(dep => !declared.includes(dep))
  report(undeclared.length === 0, `every import in dist is a dependency${undeclared.length ? `: missing ${undeclared.join(', ')}` : ''}`)

  // 2. Tarballs: the six engines from ../utilitly-oss, plus this package.
  const tarballs = join(work, 'tarballs')
  mkdirSync(tarballs)
  const engines = Object.entries(manifest.dependencies).filter(([name]) => name.startsWith('@utilitly/')).map(([name]) => name)
  for (const name of engines) {
    const dir = join(ROOT, '..', 'utilitly-oss', 'packages', name.slice('@utilitly/'.length))
    if (!existsSync(join(dir, 'dist'))) throw new Error(`${name} isn't built: run npm run build in ../utilitly-oss first`)
    run(npm, ['pack', '--pack-destination', tarballs], dir)
  }
  const packed = JSON.parse(run(npm, ['pack', '--json', '--pack-destination', tarballs], stage))[0]
  console.log(`packed ${packed.name}: ${packed.files.map(f => f.path).join(', ')}`)

  // 3. A brand-new project that installs them, as npm users would.
  const app = join(work, 'app')
  mkdirSync(app)
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'smoke-app', private: true }))
  run(npm, ['install', '--no-audit', '--no-fund', '--prefer-offline', ...readdirSync(tarballs).map(t => join(tarballs, t))], app)
  report(true, `installed @utilitly/mcp with ${engines.length} engine packages into a fresh project`)

  // 4. Start the installed command and use every tool.
  const pdfs = join(work, 'pdfs')
  mkdirSync(pdfs)
  writeFileSync(join(pdfs, 'a.pdf'), await samplePdf(4))
  writeFileSync(join(pdfs, 'b.pdf'), await samplePdf(2))
  const client = new Client({ name: 'smoke', version: '1.0.0' })
  await client.connect(new StdioClientTransport({ command: join(app, 'node_modules', '.bin', 'utilitly-mcp'), args: [pdfs], stderr: 'pipe' }))
  try {
    const { tools } = await client.listTools()
    report(tools.length === 8, `the installed server lists ${tools.length} tools`)
    const a = join(pdfs, 'a.pdf')
    const checks = [
      ['pdf_info', { path: a }, async r => r.structuredContent?.pages === 4],
      ['merge_pdfs', { paths: [a, join(pdfs, 'b.pdf')] }, async () => (await order(join(pdfs, 'a-merged.pdf'))).join() === '1,2,3,4,1,2'],
      ['split_pdf', { path: a, ranges: '1-2, 3-end' }, async () => (await order(join(pdfs, 'a-part2.pdf'))).join() === '3,4'],
      ['extract_pages', { path: a, pages: '3' }, async () => (await order(join(pdfs, 'a-pages.pdf'))).join() === '3'],
      ['rotate_pdf', { path: a, angle: 90 }, async r => r.structuredContent?.pages === 4],
      ['delete_pages', { path: a, pages: '1' }, async () => (await order(join(pdfs, 'a-trimmed.pdf'))).join() === '2,3,4'],
      ['reorder_pages', { path: a, order: [4, 3, 2, 1] }, async () => (await order(join(pdfs, 'a-reordered.pdf'))).join() === '4,3,2,1'],
      ['duplicate_pages', { path: a, pages: '2' }, async () => (await order(join(pdfs, 'a-duplicated.pdf'))).join() === '1,2,2,3,4'],
    ]
    for (const [name, args, ok] of checks) {
      const result = await client.callTool({ name, arguments: args })
      report(!result.isError && (await ok(result)), `installed ${name}`)
    }
  } finally {
    await client.close()
  }
} catch (error) {
  failed = true
  console.error(error.stderr || error)
} finally {
  rmSync(work, { recursive: true, force: true })
}

console.log(failed ? '\nSmoke install failed.' : '\nSmoke install passed: published form linted, installed from tarballs, every tool ran over stdio.')
process.exitCode = failed ? 1 : 0
