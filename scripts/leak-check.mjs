// Leak check: fails if a secret, a path from someone's computer, or anything on
// the maintainer's private list made it into this repo. Runs in CI and before
// every publish.
//
//   node scripts/leak-check.mjs [folder]   (defaults to the repo root)
//
// The public rules below run everywhere. The private list never goes in the
// repo, since a list of words that must not appear would show those words. It
// is read from ~/.config/utilitly/leak-rules.json, or from the file named by
// UTILITLY_LEAK_RULES, when that file exists:
//
//   { "content": [{ "name", "pattern", "flags" }], "paths": [{ "name", "pattern", "flags" }] }
//
// Content rules are tested against every line of every text file, path rules
// against each file's path. Patterns are JavaScript regular expressions.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative, sep, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const PUBLIC_RULES = {
  content: [
    { name: 'API key or secret', pattern: /\b[spr]k_(live|test)_[A-Za-z0-9]{8,}|\bwhsec_[A-Za-z0-9]{8,}/ },
    { name: 'GitHub token', pattern: /\bghp_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{22,}/ },
    { name: 'AWS access key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
    { name: 'Private key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
    // A home folder shows whose computer a file came from. Backslashes may be
    // escaped, as they are inside JSON and JavaScript strings.
    { name: 'Local machine path', pattern: /\/(Users|home)\/[A-Za-z]|[A-Za-z]:\\{1,2}Users\\{1,2}[A-Za-z]/ },
  ],
  paths: [{ name: 'Environment file', pattern: /(^|\/)\.env(\.|$)/ }],
}

export const PRIVATE_RULES_FILE =
  process.env.UTILITLY_LEAK_RULES || join(homedir(), '.config', 'utilitly', 'leak-rules.json')

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage'])

const SKIP_FILES = new Set([
  // Integrity hashes are random base64 and can spell a banned word by chance.
  // Dependencies are still checked through every package.json.
  'package-lock.json',
])

const BINARY_EXTENSIONS = /\.(pdf|png|jpe?g|gif|webp|avif|ico|wasm|woff2?|ttf|otf|zip|gz|tgz)$/i

// Returns null when the file isn't there, so a fresh clone or CI runs the
// public rules only.
export function loadPrivateRules(file = PRIVATE_RULES_FILE) {
  if (!existsSync(file)) return null
  const { content = [], paths = [] } = JSON.parse(readFileSync(file, 'utf8'))
  // A g or y flag would make test() carry its position from one line to the next.
  const toRule = ({ name, pattern, flags = '' }) => ({ name, pattern: new RegExp(pattern, flags.replace(/[gy]/g, '')) })
  return { content: content.map(toRule), paths: paths.map(toRule) }
}

export function findLeaks(text, rules = PUBLIC_RULES.content) {
  const leaks = []
  text.split(/\r?\n/).forEach((content, i) => {
    for (const rule of rules) {
      if (rule.pattern.test(content)) leaks.push({ line: i + 1, rule: rule.name })
    }
  })
  return leaks
}

export function bannedPathReason(path, rules = PUBLIC_RULES.paths) {
  return rules.find(rule => rule.pattern.test(path))?.name ?? null
}

function* walk(dir, root) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* walk(full, root)
    } else if (entry.isFile()) {
      yield relative(root, full).split(sep).join('/')
    }
  }
}

export function scanTree(root, rules = PUBLIC_RULES) {
  const findings = []
  let files = 0
  for (const file of walk(root, root)) {
    if (SKIP_FILES.has(file)) continue
    files++
    const pathRule = bannedPathReason(file, rules.paths)
    if (pathRule) findings.push({ file, line: null, rule: pathRule })
    if (BINARY_EXTENSIONS.test(file)) continue
    const bytes = readFileSync(join(root, file))
    if (bytes.includes(0)) continue
    for (const leak of findLeaks(bytes.toString('utf8'), rules.content)) findings.push({ file, ...leak })
  }
  return { files, findings }
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`
const ruleCount = rules => rules.content.length + rules.paths.length

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href

if (isMain) {
  const root = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..'))
  const privateRules = loadPrivateRules()
  const rules = privateRules
    ? {
        content: [...PUBLIC_RULES.content, ...privateRules.content],
        paths: [...PUBLIC_RULES.paths, ...privateRules.paths],
      }
    : PUBLIC_RULES
  const { files, findings } = scanTree(root, rules)
  const publicRules = plural(ruleCount(PUBLIC_RULES), 'public rule')
  const ruleSets = privateRules
    ? `${publicRules} + ${plural(ruleCount(privateRules), 'private rule')}`
    : `private rules not found, ${publicRules} only`
  const summary = `${plural(files, 'file')}, ${ruleSets}`
  if (findings.length > 0) {
    for (const f of findings) console.error(`${f.file}${f.line ? `:${f.line}` : ''}  ${f.rule}`)
    console.error(`\nLeak check failed: ${plural(findings.length, 'problem')}, ${summary}.`)
    // exitCode rather than exit(): on macOS, exit() can cut off piped output.
    process.exitCode = 1
  } else {
    console.log(`Leak check passed: ${summary}.`)
  }
}
