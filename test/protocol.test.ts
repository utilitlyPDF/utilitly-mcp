// The newest MCP spec (2026-07-28) negotiates differently from 2025-era
// clients, which the other suites use; check the server speaks both.

import { describe, it, expect, afterEach } from 'vitest'
import { join } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { createMcpHandler } from '@modelcontextprotocol/server'
import { createServer } from '../src/server'
import { makePdf, pageOrder, removeTempDirs, tempDir, writeFiles } from './helpers'

afterEach(() => removeTempDirs())

describe('2026-07-28 protocol', () => {
  it('lists the tools and runs one', async () => {
    const handler = createMcpHandler(() => createServer())
    // In process: the "HTTP" requests go straight to the handler, never to a socket.
    const transport = new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), {
      fetch: (url, init) => handler.fetch(new Request(url, init)),
    })
    const client = new Client({ name: 'test-harness', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } })
    await client.connect(transport)
    try {
      const { tools } = await client.listTools()
      expect(tools).toHaveLength(8)
      const dir = tempDir()
      const { 'a.pdf': file } = writeFiles(dir, { 'a.pdf': await makePdf(3) })
      const result = await client.callTool({ name: 'reorder_pages', arguments: { path: file, order: [3, 2, 1] } })
      expect(result.isError).toBeFalsy()
      expect(await pageOrder(join(dir, 'a-reordered.pdf'))).toEqual([3, 2, 1])
    } finally {
      await client.close()
      await handler.close()
    }
  })
})
