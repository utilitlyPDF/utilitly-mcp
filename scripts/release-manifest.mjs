// Until the engine packages are on npm, package.json points at them on disk
// (file:../utilitly-oss/packages/...). This writes the form that gets
// published: each of those becomes ^<that engine's version>.
//
//   node scripts/release-manifest.mjs           prints the published package.json
//   node scripts/release-manifest.mjs --write   rewrites package.json (at release)

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export function releaseManifest(pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))) {
  const dependencies = {}
  for (const [name, spec] of Object.entries(pkg.dependencies ?? {})) {
    if (spec.startsWith('file:')) {
      const engine = JSON.parse(readFileSync(join(ROOT, spec.slice('file:'.length), 'package.json'), 'utf8'))
      if (engine.name !== name) throw new Error(`${spec} holds ${engine.name}, not ${name}`)
      dependencies[name] = `^${engine.version}`
    } else {
      dependencies[name] = spec
    }
  }
  return { ...pkg, dependencies }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const manifest = `${JSON.stringify(releaseManifest(), null, 2)}\n`
  if (process.argv.includes('--write')) writeFileSync(join(ROOT, 'package.json'), manifest)
  else process.stdout.write(manifest)
}
