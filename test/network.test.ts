// Proof that nothing goes over the network: every tool runs while any
// attempt to open a connection, resolve a host name or fetch a URL throws.

import { describe, it, expect, afterEach, vi } from 'vitest'
import net from 'node:net'
import dns from 'node:dns'
import { call, closeClients, connect, makePdf, removeTempDirs, tempDir, writeFiles } from './helpers'

afterEach(async () => {
  vi.restoreAllMocks()
  await closeClients()
  removeTempDirs()
})

describe('network', () => {
  it('every tool runs with the network blocked', async () => {
    const refuse = () => { throw new Error('network used') }
    vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(refuse)
    vi.spyOn(dns, 'lookup').mockImplementation(refuse)
    vi.spyOn(globalThis, 'fetch').mockImplementation(refuse)
    expect(() => net.connect(80, 'example.com')).toThrow('network used')

    const dir = tempDir()
    const files = writeFiles(dir, { 'a.pdf': await makePdf(4), 'b.pdf': await makePdf(2) })
    const client = await connect()
    const runs: Array<[string, Record<string, unknown>]> = [
      ['pdf_info', { path: files['a.pdf'] }],
      ['merge_pdfs', { paths: [files['a.pdf'], files['b.pdf']] }],
      ['split_pdf', { path: files['a.pdf'], ranges: '1-2, 3-end' }],
      ['extract_pages', { path: files['a.pdf'], pages: '2' }],
      ['rotate_pdf', { path: files['a.pdf'], angle: 90 }],
      ['delete_pages', { path: files['a.pdf'], pages: '1' }],
      ['reorder_pages', { path: files['a.pdf'], order: [4, 3, 2, 1] }],
      ['duplicate_pages', { path: files['a.pdf'], pages: '2' }],
    ]
    for (const [name, args] of runs) {
      const result = await call(client, name, args)
      expect(result.isError, `${name}: ${JSON.stringify(result.content)}`).toBeFalsy()
    }
  })
})
