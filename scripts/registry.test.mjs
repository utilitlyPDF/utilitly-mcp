// server.json is the MCP Registry listing. The registry refuses it unless its
// name matches mcpName in the published package.json, and its versions have to
// move with package.json at every release.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = file => JSON.parse(readFileSync(join(root, file), 'utf8'))

describe('server.json', () => {
  const pkg = read('package.json')
  const server = read('server.json')

  it('names the server and package the way package.json does', () => {
    expect(server.name).toBe(pkg.mcpName)
    expect(server.packages.map(p => p.identifier)).toEqual([pkg.name])
  })

  it('lists the version in package.json', () => {
    expect(server.version).toBe(pkg.version)
    expect(server.packages.map(p => p.version)).toEqual([pkg.version])
  })

  it('keeps the description within the registry limit of 100 characters', () => {
    expect(server.description.length).toBeLessThanOrEqual(100)
  })
})
