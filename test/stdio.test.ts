// The built command, started as its own process and spoken to over stdio,
// the way AI apps run it. `npm run check` builds before testing.

import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { makePdf, pageOrder, removeTempDirs, tempDir, writeFiles } from './helpers'

const BIN = resolve(__dirname, '..', 'dist', 'index.mjs')

beforeAll(() => {
  if (!existsSync(BIN)) throw new Error('dist/index.mjs is missing: run `npm run build` first')
})

afterEach(() => removeTempDirs())

async function start(args: string[] = []) {
  const client = new Client({ name: 'stdio-test', version: '1.0.0' })
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [BIN, ...args], stderr: 'pipe' }))
  return client
}

describe('the utilitly-mcp command', () => {
  it('serves the tools over stdio and edits real files', async () => {
    const dir = tempDir()
    const files = writeFiles(dir, { 'a.pdf': await makePdf(2), 'b.pdf': await makePdf(1) })
    const client = await start()
    try {
      const { tools } = await client.listTools()
      expect(tools).toHaveLength(8)
      const result = await client.callTool({ name: 'merge_pdfs', arguments: { paths: [files['a.pdf'], files['b.pdf']] } })
      expect(result.isError).toBeFalsy()
      expect(await pageOrder(join(dir, 'a-merged.pdf'))).toEqual([1, 2, 1])
    } finally {
      await client.close()
    }
  })

  it('limits itself to the folders given on the command line', async () => {
    const first = tempDir()
    const second = tempDir()
    const { 'a.pdf': a } = writeFiles(first, { 'a.pdf': await makePdf(1) })
    const { 'b.pdf': b } = writeFiles(second, { 'b.pdf': await makePdf(2) })
    const { 'x.pdf': outside } = writeFiles(tempDir(), { 'x.pdf': await makePdf(1) })
    const client = await start([first, second])
    try {
      for (const path of [a, b]) {
        expect((await client.callTool({ name: 'pdf_info', arguments: { path } })).isError, path).toBeFalsy()
      }
      const result = await client.callTool({ name: 'pdf_info', arguments: { path: outside } })
      expect(result.isError).toBe(true)
      expect(JSON.stringify(result.content)).toContain('OUTSIDE_ALLOWED_FOLDERS')
    } finally {
      await client.close()
    }
  })

  it('expands ~ in folder arguments, since apps pass them through unexpanded', async () => {
    const home = tempDir()
    const { 'Documents/a.pdf': file } = writeFiles(home, { 'Documents/a.pdf': await makePdf(1) })
    const client = new Client({ name: 'stdio-test', version: '1.0.0' })
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: [BIN, '~/Documents'],
      env: { ...process.env, HOME: home } as Record<string, string>,
      stderr: 'pipe',
    }))
    try {
      const inside = await client.callTool({ name: 'pdf_info', arguments: { path: file } })
      expect(inside.isError).toBeFalsy()
      const outside = await client.callTool({ name: 'pdf_info', arguments: { path: '/etc/hosts' } })
      expect(JSON.stringify(outside.content)).toContain('OUTSIDE_ALLOWED_FOLDERS')
    } finally {
      await client.close()
    }
  })

  it('prints usage for --help and exits', () => {
    const run = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' })
    expect(run.status).toBe(0)
    expect(run.stdout).toContain('utilitly-mcp ~/Documents')
  })

  it('refuses a folder argument that does not exist', () => {
    const run = spawnSync(process.execPath, [BIN, '/no/such/folder'], { encoding: 'utf8' })
    expect(run.status).toBe(2)
    expect(run.stderr).toContain('is not a folder')
  })
})
