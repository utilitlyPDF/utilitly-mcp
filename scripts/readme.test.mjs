import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderAll } from './readme-art.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const readme = () => readFileSync(join(root, 'README.md'), 'utf8')

/** The sentences a reader sees: no code, tables, HTML, headings or License boilerplate. */
function proseSentences(markdown) {
  const body = markdown.split(/^## License$/m)[0].replace(/```[\s\S]*?```/g, '')
  return body
    .split('\n')
    .map(line => line.trim().replace(/^- /, ''))
    .filter(line => line && !/^[|<#>]/.test(line) && (line.match(/\]\(/g) ?? []).length < 3)
    .flatMap(line => line.split(/(?<=[.!?:])\s+/))
    .map(sentence => sentence.toLowerCase())
    .filter(sentence => sentence.length >= 40)
}

describe('README images', () => {
  const files = renderAll()

  it('match what scripts/readme-art.mjs generates', () => {
    for (const [path, contents] of Object.entries(files)) {
      expect(readFileSync(join(root, path), 'utf8'), `${path} is out of date: run node scripts/readme-art.mjs`).toBe(contents)
    }
  })

  it('carry no scripts, event handlers or external files', () => {
    for (const path of Object.keys(files)) {
      const svg = readFileSync(join(root, path), 'utf8')
      expect(svg, path).not.toMatch(/<script|<foreignObject|@import|url\(|href=|\son[a-z]+=/i)
      expect(svg.length, path).toBeLessThan(20_000)
    }
  })
})

describe('README', () => {
  it('opens with the package name', () => {
    expect(readme()).toMatch(/^# @utilitly\/mcp$/m)
  })

  it('shows its hero and its no-network test, light and dark, from files that exist', () => {
    for (const file of ['hero-light.svg', 'hero-dark.svg', 'no-network-light.svg', 'no-network-dark.svg']) {
      expect(readme()).toContain(`./assets/${file}`)
      expect(existsSync(join(root, 'assets', file)), file).toBe(true)
    }
  })

  it('follows the shared section order', () => {
    const headings = [...readme().matchAll(/^## (.+)$/gm)].map(m => m[1])
    expect(headings[0]).toBe('Install')
    expect(headings[1]).toMatch(/ in 30 seconds$/)
    expect(headings.indexOf('Tools')).toBeLessThan(headings.indexOf('Good to know'))
    expect(headings.at(-1)).toBe('License')
  })

  it('has alt text on every image', () => {
    for (const img of readme().match(/<img [^>]*>/g)) expect(img).toMatch(/alt="[^"]{20,}"/)
  })

  it('shares no sentences with the engine READMEs, so npm shows distinct pages', () => {
    const engines = join(root, '..', 'utilitly-oss', 'packages')
    if (!existsSync(engines)) return // CI without the engines checked out next to it
    const theirs = new Set(
      readdirSync(engines)
        .filter(name => existsSync(join(engines, name, 'README.md')))
        .flatMap(name => proseSentences(readFileSync(join(engines, name, 'README.md'), 'utf8'))),
    )
    expect(proseSentences(readme()).filter(sentence => theirs.has(sentence))).toEqual([])
  })
})
