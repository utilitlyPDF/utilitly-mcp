// Shared fixtures for the suites. Never imported by src, so not part of the build.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PDFDocument, degrees } from 'pdf-lib'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { createServer, type ServerOptions } from '../src/server'

/**
 * A PDF whose page n is 600 + n points wide, so a page can be recognised
 * after any edit and order is checked without extracting text.
 */
export async function makePdf(pages: number, rotations: number[] = []): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  for (let n = 1; n <= pages; n++) {
    const page = doc.addPage([600 + n, 800])
    if (rotations[n - 1]) page.setRotation(degrees(rotations[n - 1]))
  }
  return doc.save()
}

/** The page numbers of the original document, in the order a file now holds them. */
export async function pageOrder(file: string): Promise<number[]> {
  const doc = await PDFDocument.load(await readFile(file))
  return doc.getPages().map(page => Math.round(page.getWidth()) - 600)
}

export async function pageRotations(file: string): Promise<number[]> {
  const doc = await PDFDocument.load(await readFile(file))
  return doc.getPages().map(page => page.getRotation().angle)
}

/** Encrypts with qpdf, for tests that need a password-protected input. */
export async function encrypt(bytes: Uint8Array, password: string): Promise<Uint8Array> {
  const require = createRequire(import.meta.url)
  const createQpdf = require('@neslinesli93/qpdf-wasm')
  const qpdf = await createQpdf({ thisProgram: 'qpdf' })
  qpdf.FS.writeFile('/in.pdf', bytes)
  const previous = process.exitCode
  qpdf.callMain(['--encrypt', `--user-password=${password}`, `--owner-password=${password}`, '--bits=256', '--', '/in.pdf', '/out.pdf'])
  process.exitCode = previous
  return qpdf.FS.readFile('/out.pdf')
}

const dirs: string[] = []

/** A fresh temp folder, resolved (macOS's /var is a symlink to /private/var). */
export function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'utilitly-mcp-')))
  dirs.push(dir)
  return dir
}

export function removeTempDirs(): void {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
}

/** Writes `files` (relative path -> bytes) under `dir` and returns their absolute paths. */
export function writeFiles(dir: string, files: Record<string, Uint8Array | string>): Record<string, string> {
  const paths: Record<string, string> = {}
  for (const [name, bytes] of Object.entries(files)) {
    const path = join(dir, name)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, bytes)
    paths[name] = path
  }
  return paths
}

const clients: Client[] = []

/** A client connected in memory to a fresh server instance. */
export async function connect(options: ServerOptions = {}): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const server = createServer(options)
  const client = new Client({ name: 'test-harness', version: '1.0.0' })
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  clients.push(client)
  return client
}

export async function closeClients(): Promise<void> {
  for (const client of clients.splice(0)) await client.close()
}

type ToolResult = {
  content?: Array<{ type: string; text?: string }>
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

export async function call(client: Client, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as ToolResult
}

export function text(result: ToolResult): string {
  return (result.content ?? []).map(block => block.text ?? '').join('\n')
}
