// The MCP server: nine tools over the @utilitly PDF and image engines.

import { McpServer } from '@modelcontextprotocol/server'
import * as z from 'zod/v4'
import { PDFDocument } from 'pdf-lib'
import { cropImage } from '@utilitly/image-crop'
import { mergePdfs } from '@utilitly/pdf-merge'
import { extractPages, parsePageRange, splitPdf } from '@utilitly/pdf-split'
import { rotatePdf } from '@utilitly/pdf-rotate'
import { deletePages } from '@utilitly/pdf-delete-pages'
import { reorderPages } from '@utilitly/pdf-reorder-pages'
import { duplicatePages } from '@utilitly/pdf-duplicate-pages'
import { dirname } from 'node:path'
import pkg from '../package.json' with { type: 'json' }
import { ToolError, Workspace, stem, writeAsNew, writeExact } from './files'

export type ServerOptions = {
  /** When set, every file read or written must be inside one of these folders. */
  allowedFolders?: string[]
}

const PATH = 'Absolute path to a PDF file, or one starting with ~/.'
const EXAMPLES = 'such as "2", "1-3, 5" or "4-end". Commas separate parts.'
const PAGES = `Pages, ${EXAMPLES}`
const OUTPUT_PATH = 'Optional absolute path for the new PDF, ending in .pdf. It must not exist yet. By default the result goes next to the input.'
const NEW_FILE = 'Writes the result as a new file next to the input (or to output_path) and never replaces an existing file; the input is left unchanged.'

const WRITES = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
const READS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }

const oneFile = z.object({
  output_path: z.string().describe('Where the new PDF was written'),
  pages: z.number().int().describe('Pages in the new PDF'),
})

const label = (pages: number) => `${pages} ${pages === 1 ? 'page' : 'pages'}`

async function pageCount(bytes: Uint8Array): Promise<number> {
  return (await PDFDocument.load(bytes, { updateMetadata: false })).getPageCount()
}

/**
 * One call can add at most this many pages beyond what its input files hold,
 * so repeated copies, overlapping ranges or a file listed over and over can't
 * use up memory or disk.
 */
const MAX_ADDED_PAGES = 10_000
/** split_pdf writes at most this many files, or one per page for longer PDFs. */
const MAX_SPLIT_FILES = 1_000

const count = (n: number) => n.toLocaleString('en-US')

/** The page count for a size check, or null to let the engine report a bad file. */
async function countForCheck(bytes: Uint8Array): Promise<number | null> {
  try {
    return (await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false })).getPageCount()
  } catch {
    return null
  }
}

/** Runs before the engine, so nothing is built or written when it fails. */
function checkSize(outputPages: number, inputPages: number): void {
  if (outputPages > inputPages + MAX_ADDED_PAGES) {
    throw new ToolError(
      'TOO_LARGE',
      `That would make ${count(outputPages)} pages from ${count(inputPages)}. One call can add at most ${count(MAX_ADDED_PAGES)} pages, so ask for fewer copies, ranges or files.`,
    )
  }
}

/** Engine errors carry a code such as NO_PAGES; pass it on with the message. */
function toToolError(error: unknown): unknown {
  const e = error as { name?: string; code?: unknown; message?: string }
  if ((e?.name === 'PdfError' || e?.name === 'ImageError') && typeof e.code === 'string') return new ToolError(e.code, e.message ?? '')
  return error
}

type ImageFormat = 'jpeg' | 'png' | 'webp'
const IMAGE_LABEL: Record<ImageFormat, string> = { jpeg: 'JPEG', png: 'PNG', webp: 'WebP' }
/** The extensions an output_path may have for each format; the first is used for new names. */
const IMAGE_EXTENSIONS: Record<ImageFormat, readonly string[]> = { jpeg: ['.jpg', '.jpeg'], png: ['.png'], webp: ['.webp'] }
/** Dropped from the input's name when naming the result: photo.jpg gives photo-cropped.jpg. */
const IMAGE_INPUT_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp']

/** The format the bytes are in, from their first bytes, or null to let the engine report what they are. */
function imageFormatOf(bytes: Uint8Array): ImageFormat | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg'
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png'
  if (Buffer.from(bytes.subarray(0, 4)).toString('latin1') === 'RIFF' && Buffer.from(bytes.subarray(8, 12)).toString('latin1') === 'WEBP') return 'webp'
  return null
}

export function createServer(options: ServerOptions = {}): McpServer {
  const server = new McpServer({ name: 'utilitly', version: pkg.version })
  const files = new Workspace(options.allowedFolders)

  /** Runs one engine on one input and writes one new PDF. */
  async function single(
    path: string,
    outputPath: string | undefined,
    suffix: string,
    edit: (bytes: Uint8Array) => Promise<Uint8Array>,
  ) {
    const input = await files.inputFile(path)
    const target = outputPath === undefined ? undefined : await files.outputFile(outputPath)
    let bytes: Uint8Array
    try {
      bytes = await edit(await files.read(input))
    } catch (error) {
      throw toToolError(error)
    }
    const written = target
      ? await writeExact(target, bytes)
      : (await writeAsNew(dirname(input), [{ base: `${stem(input)}-${suffix}`, bytes }]))[0]
    const pages = await pageCount(bytes)
    return {
      content: [{ type: 'text' as const, text: `Wrote ${written} (${label(pages)}).` }],
      structuredContent: { output_path: written, pages },
    }
  }

  server.registerTool(
    'pdf_info',
    {
      title: 'PDF info',
      description: 'Reads a PDF and reports its page count, file size, first page size in points, and whether it is password-protected. Changes nothing.',
      inputSchema: z.object({ path: z.string().describe(PATH) }),
      outputSchema: z.object({
        path: z.string(),
        pages: z.number().int().nullable().describe('Null when the file is encrypted in a way that hides its page list'),
        file_size_bytes: z.number().int(),
        encrypted: z.boolean(),
        first_page: z.object({ width: z.number(), height: z.number() }).nullable(),
      }),
      annotations: READS,
    },
    async ({ path }) => {
      const file = await files.inputFile(path)
      const bytes = await files.read(file)
      let info: { pages: number | null; encrypted: boolean; first_page: { width: number; height: number } | null }
      try {
        const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false })
        const first = doc.getPageCount() > 0 ? doc.getPage(0).getSize() : null
        info = {
          pages: doc.getPageCount(),
          encrypted: doc.isEncrypted,
          first_page: first && { width: Math.round(first.width * 100) / 100, height: Math.round(first.height * 100) / 100 },
        }
      } catch (error) {
        // Strongly encrypted files can hide their page tree from pdf-lib.
        if (!Buffer.from(bytes).includes('/Encrypt')) throw new ToolError('NOT_A_PDF', `${file} could not be read as a PDF.`)
        info = { pages: null, encrypted: true, first_page: null }
      }
      const structured = { path: file, file_size_bytes: bytes.length, ...info }
      const summary = [
        info.pages === null ? 'page count hidden by encryption' : label(info.pages),
        `${bytes.length} bytes`,
        info.encrypted ? 'password-protected' : 'not password-protected',
      ].join(', ')
      return { content: [{ type: 'text', text: `${file}: ${summary}.` }], structuredContent: structured }
    },
  )

  server.registerTool(
    'merge_pdfs',
    {
      title: 'Merge PDFs',
      description: `Combines PDFs into one, in the order given. The result is named after the first file, with -merged. ${NEW_FILE}`,
      inputSchema: z.object({
        paths: z.array(z.string()).min(1).describe('Absolute paths of the PDFs to combine, in order'),
        output_path: z.string().optional().describe(OUTPUT_PATH),
      }),
      outputSchema: oneFile,
      annotations: WRITES,
    },
    async ({ paths, output_path }) => {
      const inputs = []
      for (const path of paths) inputs.push(await files.inputFile(path))
      const target = output_path === undefined ? undefined : await files.outputFile(output_path)
      // A file listed more than once is read and counted once.
      const contents = new Map<string, Uint8Array>()
      for (const input of inputs) if (!contents.has(input)) contents.set(input, await files.read(input))
      const pagesIn = new Map<string, number>()
      for (const [input, bytes] of contents) pagesIn.set(input, (await countForCheck(bytes)) ?? 0)
      const total = (list: Iterable<string>) => [...list].reduce((sum, input) => sum + (pagesIn.get(input) ?? 0), 0)
      checkSize(total(inputs), total(contents.keys()))
      let bytes: Uint8Array
      try {
        bytes = await mergePdfs(inputs.map(input => contents.get(input)!))
      } catch (error) {
        throw toToolError(error)
      }
      const written = target
        ? await writeExact(target, bytes)
        : (await writeAsNew(dirname(inputs[0]), [{ base: `${stem(inputs[0])}-merged`, bytes }]))[0]
      const pages = await pageCount(bytes)
      return {
        content: [{ type: 'text', text: `Wrote ${written} (${label(pages)}).` }],
        structuredContent: { output_path: written, pages },
      }
    },
  )

  server.registerTool(
    'split_pdf',
    {
      title: 'Split a PDF',
      description: `Splits a PDF into one new file per comma-separated range, named -part1, -part2 and so on. "1-2, 3-end" gives two files, and one call writes at most 1,000 (or one per page for longer PDFs). Never replaces an existing file; the input is left unchanged.`,
      inputSchema: z.object({
        path: z.string().describe(PATH),
        ranges: z.string().describe('Ranges such as "1-2, 3, 4-end": one output file per comma-separated part'),
        output_folder: z.string().optional().describe('Optional absolute path of an existing folder for the files. By default they go next to the input.'),
      }),
      outputSchema: z.object({
        output_paths: z.array(z.string()).describe('The new PDFs, one per range'),
        pages: z.array(z.number().int()).describe('Pages in each new PDF'),
      }),
      annotations: WRITES,
    },
    async ({ path, ranges, output_folder }) => {
      const input = await files.inputFile(path)
      const folder = output_folder === undefined ? dirname(input) : await files.outputFolder(output_folder)
      const bytes = await files.read(input)
      const pagesIn = await countForCheck(bytes)
      if (pagesIn !== null) {
        const selections = ranges.split(',').map(s => s.trim()).filter(Boolean)
        const maxFiles = Math.max(MAX_SPLIT_FILES, pagesIn)
        if (selections.length > maxFiles) {
          throw new ToolError(
            'TOO_MANY_FILES',
            `${count(selections.length)} ranges would write ${count(selections.length)} files. One split writes at most ${count(maxFiles)}, so use fewer, longer ranges.`,
          )
        }
        checkSize(selections.reduce((sum, part) => sum + parsePageRange(part, pagesIn).length, 0), pagesIn)
      }
      let parts: Uint8Array[]
      try {
        parts = await splitPdf(bytes, ranges)
      } catch (error) {
        throw toToolError(error)
      }
      const written = await writeAsNew(folder, parts.map((bytes, i) => ({ base: `${stem(input)}-part${i + 1}`, bytes })))
      const pages = await Promise.all(parts.map(pageCount))
      return {
        content: [{ type: 'text', text: `Wrote ${written.length} files:\n${written.map((file, i) => `${file} (${label(pages[i])})`).join('\n')}` }],
        structuredContent: { output_paths: written, pages },
      }
    },
  )

  server.registerTool(
    'extract_pages',
    {
      title: 'Extract pages',
      description: `Copies the selected pages into one new PDF, in page order, named with -pages. ${NEW_FILE}`,
      inputSchema: z.object({ path: z.string().describe(PATH), pages: z.string().describe(PAGES), output_path: z.string().optional().describe(OUTPUT_PATH) }),
      outputSchema: oneFile,
      annotations: WRITES,
    },
    async ({ path, pages, output_path }) => single(path, output_path, 'pages', bytes => extractPages(bytes, pages)),
  )

  server.registerTool(
    'rotate_pdf',
    {
      title: 'Rotate pages',
      description: `Turns pages clockwise by a multiple of 90 degrees (negative turns counter-clockwise), every page unless pages is given. Named with -rotated. ${NEW_FILE}`,
      inputSchema: z.object({
        path: z.string().describe(PATH),
        angle: z.number().int().describe('Degrees clockwise: 90, 180, 270, or -90 for counter-clockwise'),
        pages: z.string().optional().describe(`${PAGES} Every page when left out.`),
        output_path: z.string().optional().describe(OUTPUT_PATH),
      }),
      outputSchema: oneFile,
      annotations: WRITES,
    },
    async ({ path, angle, pages, output_path }) => single(path, output_path, 'rotated', bytes => rotatePdf(bytes, angle, { pages })),
  )

  server.registerTool(
    'delete_pages',
    {
      title: 'Delete pages',
      description: `Removes the selected pages and keeps the rest in order, named with -trimmed. At least one page must remain. ${NEW_FILE}`,
      inputSchema: z.object({ path: z.string().describe(PATH), pages: z.string().describe(`Pages to remove, ${EXAMPLES}`), output_path: z.string().optional().describe(OUTPUT_PATH) }),
      outputSchema: oneFile,
      annotations: WRITES,
    },
    async ({ path, pages, output_path }) => single(path, output_path, 'trimmed', bytes => deletePages(bytes, pages)),
  )

  server.registerTool(
    'reorder_pages',
    {
      title: 'Reorder pages',
      description: `Puts the pages in a new order, named with -reordered. The order must list every page exactly once; use pdf_info for the page count. ${NEW_FILE}`,
      inputSchema: z.object({
        path: z.string().describe(PATH),
        order: z.array(z.number().int().min(1)).min(1).describe('Every page number once, in the new order, e.g. [3, 1, 2]'),
        output_path: z.string().optional().describe(OUTPUT_PATH),
      }),
      outputSchema: oneFile,
      annotations: WRITES,
    },
    async ({ path, order, output_path }) => single(path, output_path, 'reordered', bytes => reorderPages(bytes, order)),
  )

  server.registerTool(
    'duplicate_pages',
    {
      title: 'Duplicate pages',
      description: `Adds copies of the selected pages, right after each one or all at the end, named with -duplicated. Copies share the page's images, so the file barely grows. One call can add at most 10,000 pages. ${NEW_FILE}`,
      inputSchema: z.object({
        path: z.string().describe(PATH),
        pages: z.string().describe(`Pages to copy, ${EXAMPLES}`),
        copies: z.number().int().min(1).optional().describe('Extra copies of each page. Default 1.'),
        placement: z.enum(['after', 'end']).optional().describe('"after" (default) puts copies right after each page; "end" adds them at the end.'),
        output_path: z.string().optional().describe(OUTPUT_PATH),
      }),
      outputSchema: oneFile,
      annotations: WRITES,
    },
    async ({ path, pages, copies, placement, output_path }) =>
      single(path, output_path, 'duplicated', async bytes => {
        const pagesIn = await countForCheck(bytes)
        if (pagesIn !== null) checkSize(pagesIn + parsePageRange(pages, pagesIn).length * (copies ?? 1), pagesIn)
        return duplicatePages(bytes, pages, { copies, placement })
      }),
  )

  server.registerTool(
    'crop_image',
    {
      title: 'Crop an image',
      description: `Crops a JPEG, PNG or WebP image to a rectangle, or to the largest centred area of a shape such as 1:1, 4:3 or 16:9. Coordinates are pixels of the photo as it is shown upright. The result keeps the input's format unless format is given, and is named with -cropped. Writes the result as a new file next to the input (or to output_path) and never replaces an existing file; the input is left unchanged.`,
      inputSchema: z.object({
        path: z.string().describe('Absolute path to a JPEG, PNG or WebP image, or one starting with ~/.'),
        aspect: z.union([z.enum(['1:1', '4:3', '16:9']), z.number().positive()]).optional()
          .describe('Crop to the middle of the image at this shape: "1:1", "4:3", "16:9", or width ÷ height as a number. Give this, or x, y, width and height.'),
        x: z.number().int().optional().describe('Left edge of the rectangle, in pixels from the left'),
        y: z.number().int().optional().describe('Top edge of the rectangle, in pixels from the top'),
        width: z.number().int().optional().describe('Width of the rectangle, in pixels'),
        height: z.number().int().optional().describe('Height of the rectangle, in pixels'),
        format: z.enum(['jpeg', 'jpg', 'png', 'webp']).optional().describe("Write this format instead of the input's"),
        quality: z.number().optional().describe('40 to 100, for JPEG and WebP output. Default 90.'),
        output_path: z.string().optional().describe('Optional absolute path for the new image, ending in an extension for its format (.jpg, .png or .webp). It must not exist yet. By default the result goes next to the input.'),
      }),
      outputSchema: z.object({
        output_path: z.string().describe('Where the new image was written'),
        format: z.enum(['jpeg', 'png', 'webp']).describe('The format it was written in'),
        file_size_bytes: z.number().int(),
      }),
      annotations: WRITES,
    },
    async ({ path, aspect, x, y, width, height, format, quality, output_path }) => {
      const rectangle = [x, y, width, height]
      const wholeRectangle = rectangle.every(v => v !== undefined)
      const anyRectangle = rectangle.some(v => v !== undefined)
      if (aspect === undefined ? !wholeRectangle : anyRectangle) {
        throw new ToolError('INVALID_OPTIONS', 'Give either aspect, or all of x, y, width and height.')
      }
      const input = await files.inputFile(path)
      const bytes = await files.read(input)
      // The output format names the file; when it can't be told, the engine reports what the file is.
      const outFormat: ImageFormat | null = format === undefined ? imageFormatOf(bytes) : format === 'jpg' ? 'jpeg' : format
      const target = output_path === undefined || outFormat === null ? undefined : await files.outputFile(output_path, IMAGE_EXTENSIONS[outFormat])
      let cropped: Uint8Array
      try {
        const area = aspect !== undefined ? { aspect } : { x: x!, y: y!, width: width!, height: height! }
        cropped = await cropImage(bytes, area, { format, quality })
      } catch (error) {
        throw toToolError(error)
      }
      const written = target
        ? await writeExact(target, cropped)
        : (await writeAsNew(dirname(input), [{ base: `${stem(input, IMAGE_INPUT_EXTENSIONS)}-cropped`, bytes: cropped }], IMAGE_EXTENSIONS[outFormat!][0]))[0]
      return {
        content: [{ type: 'text', text: `Wrote ${written} (${IMAGE_LABEL[outFormat!]}, ${cropped.length} bytes).` }],
        structuredContent: { output_path: written, format: outFormat!, file_size_bytes: cropped.length },
      }
    },
  )

  return server
}
