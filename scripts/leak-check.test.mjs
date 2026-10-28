import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { PUBLIC_RULES, loadPrivateRules, findLeaks, bannedPathReason, scanTree } from './leak-check.mjs'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'leak-check.mjs')

// Fake secrets and paths are glued together at runtime, so this file doesn't
// trip the check it tests.
const glue = (...parts) => parts.join('')
const FAKE_AWS_KEY = glue('AKIA', 'ABCDEFGHIJKLMNOP')

// An invented word and folder stand in for the private list.
const PRIVATE_LIST = {
  content: [{ name: 'Invented word', pattern: 'florbix', flags: 'i' }],
  paths: [{ name: 'Invented folder', pattern: '(^|/)florbix-notes/' }],
}

const PUBLIC_COUNT = PUBLIC_RULES.content.length + PUBLIC_RULES.paths.length

const roots = []

function tree(files) {
  const root = mkdtempSync(join(tmpdir(), 'leak-check-'))
  roots.push(root)
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  return root
}

// Kept in its own folder, outside any tree being scanned.
function rulesFile(rules) {
  return join(tree({ 'leak-rules.json': JSON.stringify(rules) }), 'leak-rules.json')
}

function withPrivate(privateRules) {
  return {
    content: [...PUBLIC_RULES.content, ...privateRules.content],
    paths: [...PUBLIC_RULES.paths, ...privateRules.paths],
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('findLeaks with the public rules', () => {
  it('flags API keys and webhook secrets', () => {
    expect(findLeaks(`key = ${glue('sk_', 'live_', '51Habcdefgh')}`)).toEqual([{ line: 1, rule: 'API key or secret' }])
    expect(findLeaks(glue('whsec_', 'abcdefgh1234'))).toEqual([{ line: 1, rule: 'API key or secret' }])
  })

  it('flags GitHub tokens', () => {
    expect(findLeaks(glue('ghp_', 'a'.repeat(36)))).toEqual([{ line: 1, rule: 'GitHub token' }])
    expect(findLeaks(glue('github_pat_', '11ABCDEFG0123456789abcdef'))).toEqual([{ line: 1, rule: 'GitHub token' }])
  })

  it('flags AWS access keys', () => {
    expect(findLeaks(`id: ${FAKE_AWS_KEY}`)).toEqual([{ line: 1, rule: 'AWS access key' }])
  })

  it('flags private key blocks', () => {
    expect(findLeaks(glue('-----BEGIN ', 'RSA PRIVATE KEY-----'))).toEqual([{ line: 1, rule: 'Private key' }])
    expect(findLeaks(glue('-----BEGIN ', 'PRIVATE KEY-----'))).toEqual([{ line: 1, rule: 'Private key' }])
  })

  it('flags home folder paths on macOS, Linux and Windows', () => {
    const paths = [
      glue('/Us', 'ers/someone/Desktop/file.pdf'),
      glue('/ho', 'me/someone/file.pdf'),
      glue('C:', '\\Users\\someone\\file.pdf'),
      glue('"C:', '\\\\Users\\\\someone"'),
    ]
    for (const path of paths) expect(findLeaks(path)).toEqual([{ line: 1, rule: 'Local machine path' }])
  })

  it('reports the line a leak is on', () => {
    expect(findLeaks(`ok\nok\n${FAKE_AWS_KEY}\n`)).toEqual([{ line: 3, rule: 'AWS access key' }])
  })

  it('returns nothing for clean code, placeholders and short look-alikes', () => {
    expect(findLeaks("import { PDFDocument } from 'pdf-lib'\nexport async function mergePdfs() {}\n")).toEqual([])
    expect(findLeaks('Put it in /Users/<name> or C:\\Users\\<name>')).toEqual([])
    expect(findLeaks('sk_test_short')).toEqual([])
  })
})

describe('bannedPathReason with the public rules', () => {
  it('flags env files at any depth', () => {
    expect(bannedPathReason('.env')).toBe('Environment file')
    expect(bannedPathReason('.env.local')).toBe('Environment file')
    expect(bannedPathReason('packages/pdf-merge/.env.production')).toBe('Environment file')
  })

  it('allows normal source and config files', () => {
    expect(bannedPathReason('packages/pdf-merge/src/index.ts')).toBeNull()
    expect(bannedPathReason('.github/workflows/ci.yml')).toBeNull()
    expect(bannedPathReason('.gitignore')).toBeNull()
    expect(bannedPathReason('.envrc.example')).toBeNull()
  })
})

describe('loadPrivateRules', () => {
  it('returns null when the file is missing', () => {
    expect(loadPrivateRules(join(tree({}), 'missing.json'))).toBeNull()
  })

  it('turns content and path rules into regular expressions', () => {
    const rules = loadPrivateRules(rulesFile(PRIVATE_LIST))
    expect(findLeaks('Made by FLORBIX', rules.content)).toEqual([{ line: 1, rule: 'Invented word' }])
    expect(bannedPathReason('docs/florbix-notes/a.md', rules.paths)).toBe('Invented folder')
    expect(bannedPathReason('docs/notes/a.md', rules.paths)).toBeNull()
  })

  it('drops the g flag, so every matching line is caught', () => {
    const rules = loadPrivateRules(rulesFile({ content: [{ name: 'Invented word', pattern: 'florbix', flags: 'gi' }] }))
    expect(findLeaks('florbix\nflorbix', rules.content)).toHaveLength(2)
    expect(rules.paths).toEqual([])
  })
})

describe('scanTree', () => {
  it('reports leaks with the file path and line', () => {
    const root = tree({ 'packages/a/src/index.ts': `ok\nok\nconst key = '${FAKE_AWS_KEY}'\n` })
    expect(scanTree(root).findings).toEqual([{ file: 'packages/a/src/index.ts', line: 3, rule: 'AWS access key' }])
  })

  it('counts the files it scanned', () => {
    const root = tree({ 'a.ts': 'ok', 'b/c.ts': 'ok' })
    expect(scanTree(root)).toEqual({ files: 2, findings: [] })
  })

  it('skips node_modules, dist, coverage and .git', () => {
    const root = tree({
      'node_modules/x/index.js': FAKE_AWS_KEY,
      'packages/a/dist/index.mjs': FAKE_AWS_KEY,
      'coverage/report.html': FAKE_AWS_KEY,
      '.git/config': FAKE_AWS_KEY,
    })
    expect(scanTree(root).findings).toEqual([])
  })

  it('skips binary files', () => {
    const root = tree({
      'fixtures/sample.pdf': FAKE_AWS_KEY,
      'fixtures/blob.bin': Buffer.concat([Buffer.from(FAKE_AWS_KEY), Buffer.from([0])]),
    })
    expect(scanTree(root).findings).toEqual([])
  })

  it('skips the lockfile, whose random hashes can spell banned words by chance', () => {
    const root = tree({ 'package-lock.json': `"integrity": "sha512-${FAKE_AWS_KEY}=="` })
    expect(scanTree(root).findings).toEqual([])
  })

  it('reports a banned path even when its content is clean', () => {
    const root = tree({ '.env.local': 'FOO=1' })
    expect(scanTree(root).findings).toEqual([{ file: '.env.local', line: null, rule: 'Environment file' }])
  })

  it('applies private rules alongside the public ones', () => {
    const root = tree({
      'README.md': 'Built with Florbix\n',
      'docs/florbix-notes/plan.md': 'ok\n',
      'src/index.ts': `const key = '${FAKE_AWS_KEY}'\n`,
    })
    const findings = scanTree(root, withPrivate(loadPrivateRules(rulesFile(PRIVATE_LIST)))).findings
    expect(findings).toEqual(
      expect.arrayContaining([
        { file: 'README.md', line: 1, rule: 'Invented word' },
        { file: 'docs/florbix-notes/plan.md', line: null, rule: 'Invented folder' },
        { file: 'src/index.ts', line: 1, rule: 'AWS access key' },
      ]),
    )
    expect(findings).toHaveLength(3)
  })

  it('checks its own source and test too', () => {
    const root = tree({ 'scripts/leak-check.mjs': 'florbix', 'scripts/leak-check.test.mjs': 'florbix' })
    expect(scanTree(root, withPrivate(loadPrivateRules(rulesFile(PRIVATE_LIST)))).findings).toHaveLength(2)
  })
})

describe('command line', () => {
  function run(root, rules) {
    const env = { ...process.env, UTILITLY_LEAK_RULES: rules ?? join(tree({}), 'missing.json') }
    return spawnSync(process.execPath, [SCRIPT, root], { encoding: 'utf8', env })
  }

  it('exits 1 and names the file when it finds a leak', () => {
    const result = run(tree({ 'src/index.ts': `const key = '${FAKE_AWS_KEY}'\n` }))
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('src/index.ts:1  AWS access key')
  })

  it('exits 0 on a clean tree and says the private rules were not found', () => {
    const result = run(tree({ 'src/index.ts': 'export {}\n' }))
    expect(result.status).toBe(0)
    expect(result.stdout).toContain(`Leak check passed: 1 file, private rules not found, ${PUBLIC_COUNT} public rules only.`)
  })

  it('loads the private rules named by UTILITLY_LEAK_RULES', () => {
    const rules = rulesFile(PRIVATE_LIST)
    const clean = run(tree({ 'src/index.ts': 'export {}\n' }), rules)
    expect(clean.status).toBe(0)
    expect(clean.stdout).toContain(`Leak check passed: 1 file, ${PUBLIC_COUNT} public rules + 2 private rules.`)

    const leaky = run(tree({ 'README.md': 'Built with Florbix\n' }), rules)
    expect(leaky.status).toBe(1)
    expect(leaky.stderr).toContain('README.md:1  Invented word')
    expect(leaky.stderr).toContain(`${PUBLIC_COUNT} public rules + 2 private rules`)
  })
})
