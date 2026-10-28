import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { call, closeClients, connect, encrypt, makePdf, pageOrder, pageRotations, removeTempDirs, tempDir, text, writeFiles } from './helpers'

afterEach(async () => {
  await closeClients()
  removeTempDirs()
})

describe('the tool list', () => {
  it('offers the eight tools, each described for the model', async () => {
    const { tools } = await (await connect()).listTools()
    expect(tools.map(t => t.name).sort()).toEqual([
      'delete_pages', 'duplicate_pages', 'extract_pages', 'merge_pdfs',
      'pdf_info', 'reorder_pages', 'rotate_pdf', 'split_pdf',
    ])
    for (const tool of tools) expect(tool.description?.length, tool.name).toBeGreaterThan(40)
  })

  it('marks pdf_info read-only and no tool destructive', async () => {
    const { tools } = await (await connect()).listTools()
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(tool.name === 'pdf_info')
      expect(tool.annotations?.destructiveHint, tool.name).toBe(false)
      expect(tool.annotations?.openWorldHint, tool.name).toBe(false)
    }
  })
})

describe('pdf_info', () => {
  it('reports pages, size and first page size', async () => {
    const dir = tempDir()
    const { 'a.pdf': file } = writeFiles(dir, { 'a.pdf': await makePdf(3) })
    const result = await call(await connect(), 'pdf_info', { path: file })
    expect(result.isError).toBeFalsy()
    expect(result.structuredContent).toEqual({
      path: file,
      pages: 3,
      file_size_bytes: statSync(file).size,
      encrypted: false,
      first_page: { width: 601, height: 800 },
    })
    expect(text(result)).toContain('3 pages')
  })

  it('says when a file is password-protected', async () => {
    const dir = tempDir()
    const { 'locked.pdf': file } = writeFiles(dir, { 'locked.pdf': await encrypt(await makePdf(2), 'pw') })
    const result = await call(await connect(), 'pdf_info', { path: file })
    expect(result.isError).toBeFalsy()
    expect(result.structuredContent).toMatchObject({ encrypted: true })
  })
})

describe('tools that write a new PDF', () => {
  it('merge_pdfs writes the files in order, next to the first one', async () => {
    const dir = tempDir()
    const files = writeFiles(dir, { 'a.pdf': await makePdf(2), 'sub/b.pdf': await makePdf(1) })
    const result = await call(await connect(), 'merge_pdfs', { paths: [files['a.pdf'], files['sub/b.pdf']] })
    const out = join(dir, 'a-merged.pdf')
    expect(result.structuredContent).toEqual({ output_path: out, pages: 3 })
    expect(await pageOrder(out)).toEqual([1, 2, 1])
    expect(text(result)).toContain(out)
  })

  it('split_pdf writes one file per range', async () => {
    const dir = tempDir()
    const { 'r.pdf': file } = writeFiles(dir, { 'r.pdf': await makePdf(5) })
    const result = await call(await connect(), 'split_pdf', { path: file, ranges: '1-2, 3-end' })
    const outs = [join(dir, 'r-part1.pdf'), join(dir, 'r-part2.pdf')]
    expect(result.structuredContent).toEqual({ output_paths: outs, pages: [2, 3] })
    expect(await pageOrder(outs[0])).toEqual([1, 2])
    expect(await pageOrder(outs[1])).toEqual([3, 4, 5])
  })

  it('extract_pages copies the selected pages into one file', async () => {
    const dir = tempDir()
    const { 'r.pdf': file } = writeFiles(dir, { 'r.pdf': await makePdf(5) })
    const result = await call(await connect(), 'extract_pages', { path: file, pages: '4, 2' })
    expect(result.structuredContent).toEqual({ output_path: join(dir, 'r-pages.pdf'), pages: 2 })
    expect(await pageOrder(join(dir, 'r-pages.pdf'))).toEqual([2, 4])
  })

  it('rotate_pdf turns the chosen pages', async () => {
    const dir = tempDir()
    const { 's.pdf': file } = writeFiles(dir, { 's.pdf': await makePdf(3) })
    const result = await call(await connect(), 'rotate_pdf', { path: file, angle: 90, pages: '2-end' })
    expect(result.structuredContent).toEqual({ output_path: join(dir, 's-rotated.pdf'), pages: 3 })
    expect(await pageRotations(join(dir, 's-rotated.pdf'))).toEqual([0, 90, 90])
  })

  it('delete_pages removes the chosen pages', async () => {
    const dir = tempDir()
    const { 's.pdf': file } = writeFiles(dir, { 's.pdf': await makePdf(4) })
    const result = await call(await connect(), 'delete_pages', { path: file, pages: '2, 4' })
    expect(result.structuredContent).toEqual({ output_path: join(dir, 's-trimmed.pdf'), pages: 2 })
    expect(await pageOrder(join(dir, 's-trimmed.pdf'))).toEqual([1, 3])
  })

  it('reorder_pages puts the pages in the given order', async () => {
    const dir = tempDir()
    const { 's.pdf': file } = writeFiles(dir, { 's.pdf': await makePdf(3) })
    const result = await call(await connect(), 'reorder_pages', { path: file, order: [3, 1, 2] })
    expect(result.structuredContent).toEqual({ output_path: join(dir, 's-reordered.pdf'), pages: 3 })
    expect(await pageOrder(join(dir, 's-reordered.pdf'))).toEqual([3, 1, 2])
  })

  it('duplicate_pages adds copies after the page, or at the end', async () => {
    const dir = tempDir()
    const { 's.pdf': file } = writeFiles(dir, { 's.pdf': await makePdf(3) })
    const client = await connect()
    await call(client, 'duplicate_pages', { path: file, pages: '2', copies: 2 })
    expect(await pageOrder(join(dir, 's-duplicated.pdf'))).toEqual([1, 2, 2, 2, 3])
    await call(client, 'duplicate_pages', { path: file, pages: '1', placement: 'end' })
    expect(await pageOrder(join(dir, 's-duplicated-2.pdf'))).toEqual([1, 2, 3, 1])
  })

  it('writes to output_path when given one', async () => {
    const dir = tempDir()
    const { 's.pdf': file } = writeFiles(dir, { 's.pdf': await makePdf(2) })
    const out = join(dir, 'out', 'flipped.pdf')
    writeFiles(dir, { 'out/.keep': '' })
    const result = await call(await connect(), 'rotate_pdf', { path: file, angle: 180, output_path: out })
    expect(result.structuredContent).toEqual({ output_path: out, pages: 2 })
    expect(existsSync(out)).toBe(true)
  })
})

describe('errors the model can read', () => {
  it('passes on the engine error code and message', async () => {
    const dir = tempDir()
    const files = writeFiles(dir, {
      'ok.pdf': await makePdf(2),
      'locked.pdf': await encrypt(await makePdf(1), 'pw'),
      'notes.txt': 'not a pdf',
    })
    const client = await connect()
    const cases: Array<[string, Record<string, unknown>, RegExp]> = [
      ['rotate_pdf', { path: files['ok.pdf'], angle: 45 }, /^INVALID_OPTIONS: /],
      ['delete_pages', { path: files['ok.pdf'], pages: '9' }, /^NO_PAGES: .*2 pages/],
      ['merge_pdfs', { paths: [files['ok.pdf'], files['locked.pdf']] }, /^ENCRYPTED: File 2 /],
      ['split_pdf', { path: files['notes.txt'], ranges: '1' }, /^NOT_A_PDF: /],
      ['reorder_pages', { path: files['ok.pdf'], order: [2] }, /^INVALID_OPTIONS: .*page 1/],
    ]
    for (const [name, args, message] of cases) {
      const result = await call(client, name, args)
      expect(result.isError, name).toBe(true)
      expect(text(result), name).toMatch(message)
    }
  })

  it('says when a file does not exist', async () => {
    const result = await call(await connect(), 'pdf_info', { path: join(tempDir(), 'missing.pdf') })
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/^NOT_FOUND: .*missing\.pdf/)
  })
})
