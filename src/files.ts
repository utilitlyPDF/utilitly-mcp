// Everything that touches the file system: resolving paths, the optional
// folder limit, and writing results without ever replacing a file.

import { open, readFile, realpath, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** A failure the AI app shows the model, as "CODE: what happened". */
export class ToolError extends Error {
  constructor(code: string, message: string) {
    super(`${code}: ${message}`)
    this.name = 'ToolError'
  }
}

/** An absolute path, with a leading ~ expanded to the home folder. */
export function expandPath(path: string): string {
  if (path === '~' || path.startsWith('~/')) return join(homedir(), path.slice(1))
  if (!isAbsolute(path)) {
    throw new ToolError('INVALID_PATH', `"${path}" isn't an absolute path. Use a full path that starts with / or ~/.`)
  }
  return resolve(path)
}

function fsError(error: unknown, path: string, what = 'file'): never {
  const code = (error as NodeJS.ErrnoException)?.code
  if (code === 'ENOENT') throw new ToolError('NOT_FOUND', `No ${what} at ${path}.`)
  if (code === 'EACCES' || code === 'EPERM') throw new ToolError('NO_ACCESS', `Permission denied for ${path}.`)
  throw error
}

function isInside(path: string, folder: string): boolean {
  const rel = relative(folder, path)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/**
 * Paths are checked after symlinks are resolved, so a link inside an allowed
 * folder that points somewhere else is caught.
 */
export class Workspace {
  constructor(private readonly allowedFolders: readonly string[] = []) {}

  private async check(realPath: string, shown: string): Promise<void> {
    if (this.allowedFolders.length === 0) return
    const roots = await Promise.all(this.allowedFolders.map(folder => realpath(folder)))
    if (!roots.some(root => isInside(realPath, root))) {
      throw new ToolError('OUTSIDE_ALLOWED_FOLDERS', `${shown} is outside the folders this server may use: ${roots.join(', ')}.`)
    }
  }

  /** The resolved path of an existing file the server may read. */
  async inputFile(path: string): Promise<string> {
    const expanded = expandPath(path)
    const real = await realpath(expanded).catch(error => fsError(error, expanded))
    await this.check(real, expanded)
    if (!(await stat(real)).isFile()) throw new ToolError('INVALID_PATH', `${expanded} is a folder, not a file.`)
    return real
  }

  async read(path: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(path).catch(error => fsError(error, path)))
  }

  /** The resolved path of an existing folder the server may write into. */
  async outputFolder(path: string): Promise<string> {
    const expanded = expandPath(path)
    const real = await realpath(expanded).catch(error => fsError(error, expanded, 'folder'))
    await this.check(real, expanded)
    if (!(await stat(real)).isDirectory()) throw new ToolError('INVALID_PATH', `${expanded} is a file, not a folder.`)
    return real
  }

  /** Validates an explicit output path before any work is done. */
  async outputFile(path: string): Promise<string> {
    const expanded = expandPath(path)
    if (extname(expanded).toLowerCase() !== '.pdf') {
      throw new ToolError('INVALID_PATH', `output_path must end in .pdf, not "${basename(expanded)}".`)
    }
    return join(await this.outputFolder(dirname(expanded)), basename(expanded))
  }
}

/** "report" for /docs/report.pdf: the name results are based on. */
export function stem(path: string): string {
  const name = basename(path)
  return extname(name).toLowerCase() === '.pdf' ? name.slice(0, -4) : name
}

/** Creates `path` only if nothing is there yet. False if a file already exists. */
async function writeIfAbsent(path: string, bytes: Uint8Array): Promise<boolean> {
  let handle
  try {
    handle = await open(path, 'wx')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    fsError(error, path, 'folder')
  }
  try {
    await handle.writeFile(bytes)
  } catch (error) {
    await handle.close()
    await rm(path, { force: true })
    throw error
  }
  await handle.close()
  return true
}

/** Writes to exactly `path`, refusing if a file is already there. */
export async function writeExact(path: string, bytes: Uint8Array): Promise<string> {
  if (!(await writeIfAbsent(path, bytes))) {
    throw new ToolError('OUTPUT_EXISTS', `${path} already exists. This server never overwrites files, so choose another name.`)
  }
  return path
}

/**
 * Writes `files` into `folder` as `<base><suffix>.pdf` each, adding -2, -3 ...
 * to every name until the whole set fits without replacing anything.
 */
export async function writeAsNew(folder: string, files: Array<{ base: string; bytes: Uint8Array }>): Promise<string[]> {
  for (let n = 1; n <= 9999; n++) {
    const written: string[] = []
    let clash = false
    for (const file of files) {
      const path = join(folder, `${file.base}${n === 1 ? '' : `-${n}`}.pdf`)
      if (await writeIfAbsent(path, file.bytes)) {
        written.push(path)
      } else {
        clash = true
        break
      }
    }
    if (!clash) return written
    await Promise.all(written.map(path => rm(path, { force: true })))
  }
  throw new ToolError('OUTPUT_EXISTS', `Couldn't find a free file name in ${folder}.`)
}
