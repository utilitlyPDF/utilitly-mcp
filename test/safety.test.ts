import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync, readdirSync, symlinkSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { call, closeClients, connect, makePdf, pageOrder, removeTempDirs, tempDir, text, writeFiles } from './helpers'

const originalHome = process.env.HOME

afterEach(async () => {
  process.env.HOME = originalHome
  await closeClients()
  removeTempDirs()
})

describe('never overwriting', () => {
  it('picks the next free name instead of replacing a file', async () => {
    const dir = tempDir()
    const { 'a.pdf': file } = writeFiles(dir, { 'a.pdf': await makePdf(1), 'a-rotated.pdf': 'precious' })
    const result = await call(await connect(), 'rotate_pdf', { path: file, angle: 90 })
    expect(result.structuredContent).toMatchObject({ output_path: join(dir, 'a-rotated-2.pdf') })
    expect(readFileSync(join(dir, 'a-rotated.pdf'), 'utf8')).toBe('precious')
  })

  it('refuses an output_path that already exists and leaves it untouched', async () => {
    const dir = tempDir()
    const files = writeFiles(dir, { 'a.pdf': await makePdf(1), 'keep.pdf': 'precious' })
    const result = await call(await connect(), 'rotate_pdf', { path: files['a.pdf'], angle: 90, output_path: files['keep.pdf'] })
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/^OUTPUT_EXISTS: /)
    expect(readFileSync(files['keep.pdf'], 'utf8')).toBe('precious')
  })

  it('never changes the input file', async () => {
    const dir = tempDir()
    const bytes = await makePdf(3)
    const { 'a.pdf': file } = writeFiles(dir, { 'a.pdf': bytes })
    await call(await connect(), 'delete_pages', { path: file, pages: '1' })
    expect(new Uint8Array(readFileSync(file))).toEqual(bytes)
  })
})

describe('paths', () => {
  it('refuses relative paths', async () => {
    const result = await call(await connect(), 'pdf_info', { path: 'docs/a.pdf' })
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/^INVALID_PATH: /)
  })

  it('expands ~ to the home folder', async () => {
    const home = tempDir()
    process.env.HOME = home
    writeFiles(home, { 'Documents/a.pdf': await makePdf(2) })
    const result = await call(await connect(), 'pdf_info', { path: '~/Documents/a.pdf' })
    expect(result.structuredContent).toMatchObject({ path: join(home, 'Documents/a.pdf'), pages: 2 })
  })

  it('handles file names with spaces and accents', async () => {
    const dir = tempDir()
    const { 'Facture été 2026.pdf': file } = writeFiles(dir, { 'Facture été 2026.pdf': await makePdf(2) })
    const result = await call(await connect({ allowedFolders: [dir] }), 'rotate_pdf', { path: file, angle: 90 })
    expect(result.structuredContent).toMatchObject({ output_path: join(dir, 'Facture été 2026-rotated.pdf'), pages: 2 })
    expect(existsSync(join(dir, 'Facture été 2026-rotated.pdf'))).toBe(true)
  })

  it('needs output_path to end in .pdf', async () => {
    const dir = tempDir()
    const { 'a.pdf': file } = writeFiles(dir, { 'a.pdf': await makePdf(1) })
    const result = await call(await connect(), 'rotate_pdf', { path: file, angle: 90, output_path: join(dir, 'out.txt') })
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/^INVALID_PATH: /)
  })
})

describe('allowed folders', () => {
  it('works inside an allowed folder', async () => {
    const allowed = tempDir()
    const { 'a.pdf': file } = writeFiles(allowed, { 'a.pdf': await makePdf(2) })
    const result = await call(await connect({ allowedFolders: [allowed] }), 'reorder_pages', { path: file, order: [2, 1] })
    expect(result.isError).toBeFalsy()
    expect(await pageOrder(join(allowed, 'a-reordered.pdf'))).toEqual([2, 1])
  })

  it('refuses to read a file outside the allowed folders', async () => {
    const allowed = tempDir()
    const { 'a.pdf': outside } = writeFiles(tempDir(), { 'a.pdf': await makePdf(1) })
    const result = await call(await connect({ allowedFolders: [allowed] }), 'pdf_info', { path: outside })
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/^OUTSIDE_ALLOWED_FOLDERS: /)
  })

  it('refuses to write outside the allowed folders', async () => {
    const allowed = tempDir()
    const other = tempDir()
    const { 'a.pdf': file } = writeFiles(allowed, { 'a.pdf': await makePdf(1) })
    const result = await call(await connect({ allowedFolders: [allowed] }), 'rotate_pdf', { path: file, angle: 90, output_path: join(other, 'x.pdf') })
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/^OUTSIDE_ALLOWED_FOLDERS: /)
    expect(existsSync(join(other, 'x.pdf'))).toBe(false)
  })

  it('allows every listed folder, so a merge can take files from two of them', async () => {
    const first = tempDir()
    const second = tempDir()
    const { 'a.pdf': a } = writeFiles(first, { 'a.pdf': await makePdf(1) })
    const { 'b.pdf': b } = writeFiles(second, { 'b.pdf': await makePdf(2) })
    const result = await call(await connect({ allowedFolders: [first, second] }), 'merge_pdfs', { paths: [a, b] })
    expect(result.structuredContent).toMatchObject({ output_path: join(first, 'a-merged.pdf'), pages: 3 })
    expect(await pageOrder(join(first, 'a-merged.pdf'))).toEqual([1, 1, 2])
  })

  it('is not fooled by a symlink inside the allowed folder that points outside it', async () => {
    const allowed = tempDir()
    const secret = tempDir()
    writeFiles(secret, { 'private.pdf': await makePdf(1) })
    symlinkSync(secret, join(allowed, 'link'))
    const result = await call(await connect({ allowedFolders: [allowed] }), 'pdf_info', { path: join(allowed, 'link', 'private.pdf') })
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/^OUTSIDE_ALLOWED_FOLDERS: /)
  })

  it('is not fooled by a sibling folder whose name starts the same', async () => {
    const parent = tempDir()
    writeFiles(parent, { 'docs/a.pdf': await makePdf(1), 'docs-private/b.pdf': await makePdf(1) })
    const result = await call(await connect({ allowedFolders: [join(parent, 'docs')] }), 'pdf_info', { path: join(parent, 'docs-private', 'b.pdf') })
    expect(text(result)).toMatch(/^OUTSIDE_ALLOWED_FOLDERS: /)
  })
})

describe('size limits', () => {
  it('refuses duplicate_pages that would add more than 10,000 pages, and writes nothing', async () => {
    const dir = tempDir()
    const { 'a.pdf': file } = writeFiles(dir, { 'a.pdf': await makePdf(2) })
    const result = await call(await connect(), 'duplicate_pages', { path: file, pages: '1-2', copies: 5001 })
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/^TOO_LARGE: /)
    expect(readdirSync(dir)).toEqual(['a.pdf'])
  })

  it('still lets duplicate_pages add exactly 10,000 pages', async () => {
    const dir = tempDir()
    const { 'a.pdf': file } = writeFiles(dir, { 'a.pdf': await makePdf(2) })
    const result = await call(await connect(), 'duplicate_pages', { path: file, pages: '1-2', copies: 5000 })
    expect(result.structuredContent).toMatchObject({ pages: 10_002 })
  })

  it('refuses a split into more than 1,000 files, and writes nothing', async () => {
    const dir = tempDir()
    const { 'a.pdf': file } = writeFiles(dir, { 'a.pdf': await makePdf(1) })
    const result = await call(await connect(), 'split_pdf', { path: file, ranges: '1,'.repeat(1001) })
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/^TOO_MANY_FILES: /)
    expect(readdirSync(dir)).toEqual(['a.pdf'])
  })

  it('refuses overlapping split ranges that would add more than 10,000 pages', async () => {
    const dir = tempDir()
    const { 'a.pdf': file } = writeFiles(dir, { 'a.pdf': await makePdf(20) })
    const result = await call(await connect(), 'split_pdf', { path: file, ranges: Array(600).fill('1-end').join(',') })
    expect(text(result)).toMatch(/^TOO_LARGE: /)
    expect(readdirSync(dir)).toEqual(['a.pdf'])
  })

  it('refuses merging one file listed so often that it would add more than 10,000 pages', async () => {
    const dir = tempDir()
    const { 'a.pdf': file } = writeFiles(dir, { 'a.pdf': await makePdf(1) })
    const result = await call(await connect(), 'merge_pdfs', { paths: Array(10_002).fill(file) })
    expect(text(result)).toMatch(/^TOO_LARGE: /)
    expect(readdirSync(dir)).toEqual(['a.pdf'])
  })

  it('still merges a file listed twice', async () => {
    const dir = tempDir()
    const { 'a.pdf': file } = writeFiles(dir, { 'a.pdf': await makePdf(2) })
    const result = await call(await connect(), 'merge_pdfs', { paths: [file, file] })
    expect(result.structuredContent).toMatchObject({ pages: 4 })
    expect(await pageOrder(join(dir, 'a-merged.pdf'))).toEqual([1, 2, 1, 2])
  })
})
