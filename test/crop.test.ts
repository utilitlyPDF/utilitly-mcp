import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { call, closeClients, connect, imageFormat, makePdf, makePng, pngSize, removeTempDirs, tempDir, text, writeFiles } from './helpers'

afterEach(async () => {
  await closeClients()
  removeTempDirs()
})

describe('crop_image', () => {
  it('crops to a shape, writing -cropped next to the input in the same format', async () => {
    const dir = tempDir()
    const original = makePng(320, 240)
    const { 'photo.png': file } = writeFiles(dir, { 'photo.png': original })
    const result = await call(await connect(), 'crop_image', { path: file, aspect: '1:1' })
    expect(result.isError, text(result)).toBeFalsy()
    const out = join(dir, 'photo-cropped.png')
    expect(result.structuredContent).toEqual({ output_path: out, format: 'png', file_size_bytes: statSync(out).size })
    expect(await pngSize(out)).toEqual([240, 240])
    expect(text(result)).toContain(out)
    expect(new Uint8Array(readFileSync(file))).toEqual(original)
  })

  it('crops a rectangle given in pixels', async () => {
    const dir = tempDir()
    const { 'photo.png': file } = writeFiles(dir, { 'photo.png': makePng(320, 240) })
    const result = await call(await connect(), 'crop_image', { path: file, x: 10, y: 20, width: 100, height: 50 })
    expect(result.isError, text(result)).toBeFalsy()
    expect(await pngSize(join(dir, 'photo-cropped.png'))).toEqual([100, 50])
  })

  it('writes another format when asked, with that format\'s extension', async () => {
    const dir = tempDir()
    const { 'photo.png': file } = writeFiles(dir, { 'photo.png': makePng(64, 48) })
    const client = await connect()
    const jpeg = await call(client, 'crop_image', { path: file, aspect: 1, format: 'jpg' })
    expect(jpeg.structuredContent).toMatchObject({ output_path: join(dir, 'photo-cropped.jpg'), format: 'jpeg' })
    expect(await imageFormat(join(dir, 'photo-cropped.jpg'))).toBe('jpeg')
    const webp = await call(client, 'crop_image', { path: join(dir, 'photo-cropped.jpg'), aspect: '16:9', format: 'webp', quality: 80 })
    expect(webp.structuredContent).toMatchObject({ output_path: join(dir, 'photo-cropped-cropped.webp'), format: 'webp' })
    expect(await imageFormat(join(dir, 'photo-cropped-cropped.webp'))).toBe('webp')
  })

  it('never replaces an existing file', async () => {
    const dir = tempDir()
    const { 'photo.png': file } = writeFiles(dir, { 'photo.png': makePng(64, 48) })
    const client = await connect()
    await call(client, 'crop_image', { path: file, aspect: '1:1' })
    const again = await call(client, 'crop_image', { path: file, aspect: '4:3' })
    expect(again.structuredContent).toMatchObject({ output_path: join(dir, 'photo-cropped-2.png') })
    expect(await pngSize(join(dir, 'photo-cropped.png'))).toEqual([48, 48])
  })

  it('writes to output_path when its extension fits the format', async () => {
    const dir = tempDir()
    const { 'photo.png': file } = writeFiles(dir, { 'photo.png': makePng(64, 48), 'out/keep.txt': 'x' })
    const client = await connect()
    const target = join(dir, 'out', 'square.webp')
    const ok = await call(client, 'crop_image', { path: file, aspect: '1:1', format: 'webp', output_path: target })
    expect(ok.structuredContent).toMatchObject({ output_path: target, format: 'webp' })
    const wrong = await call(client, 'crop_image', { path: file, aspect: '1:1', format: 'webp', output_path: join(dir, 'out', 'square.png') })
    expect(wrong.isError).toBe(true)
    expect(text(wrong)).toBe('INVALID_PATH: output_path must end in .webp, not "square.png".')
    const jpg = await call(client, 'crop_image', { path: file, aspect: '1:1', format: 'jpeg', output_path: join(dir, 'out', 'photo.jpeg') })
    expect(jpg.isError, text(jpg)).toBeFalsy()
  })

  it('needs either aspect, or a whole rectangle', async () => {
    const dir = tempDir()
    const { 'photo.png': file } = writeFiles(dir, { 'photo.png': makePng(64, 48) })
    const client = await connect()
    for (const args of [{}, { x: 0, y: 0 }, { aspect: '1:1', x: 0, y: 0, width: 10, height: 10 }]) {
      const result = await call(client, 'crop_image', { path: file, ...args })
      expect(result.isError, JSON.stringify(args)).toBe(true)
      expect(text(result)).toBe('INVALID_OPTIONS: Give either aspect, or all of x, y, width and height.')
    }
  })

  it("passes on the engine's error code and message", async () => {
    const dir = tempDir()
    const files = writeFiles(dir, { 'photo.png': makePng(320, 240), 'doc.pdf': await makePdf(1) })
    const client = await connect()
    const pastEdge = await call(client, 'crop_image', { path: files['photo.png'], x: 300, y: 0, width: 100, height: 50 })
    expect(text(pastEdge)).toBe('INVALID_OPTIONS: The crop area (x 300, y 0, 100 × 50) goes past the edge of the image, which is 320 × 240.')
    const lowQuality = await call(client, 'crop_image', { path: files['photo.png'], aspect: '1:1', format: 'jpeg', quality: 30 })
    expect(text(lowQuality)).toMatch(/^INVALID_OPTIONS: quality must be a number from 40 to 100/)
    const pdf = await call(client, 'crop_image', { path: files['doc.pdf'], aspect: '1:1' })
    expect(text(pdf)).toMatch(/^UNSUPPORTED_FORMAT: .* is a PDF file/)
  })

  it('stays inside the allowed folders', async () => {
    const allowed = tempDir()
    const elsewhere = tempDir()
    const { 'photo.png': file } = writeFiles(elsewhere, { 'photo.png': makePng(16, 16) })
    const result = await call(await connect({ allowedFolders: [allowed] }), 'crop_image', { path: file, aspect: '1:1' })
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/^OUTSIDE_ALLOWED_FOLDERS: /)
  })
})
