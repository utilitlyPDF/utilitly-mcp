#!/usr/bin/env node
// The command AI apps run: `utilitly-mcp [folder ...]`, speaking MCP over stdio.

import { realpath, stat } from 'node:fs/promises'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import pkg from '../package.json' with { type: 'json' }
import { expandPath } from './files'
import { createServer } from './server'

const USAGE = `utilitly-mcp ${pkg.version}

An MCP server that merges, splits, rotates, deletes, reorders and duplicates
PDF pages on this computer. Add it to an AI app's MCP settings.

  utilitly-mcp                    may use any file you can
  utilitly-mcp ~/Documents ...    may only read and write inside these folders
`

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(USAGE)
    return
  }
  if (args.includes('--version')) {
    process.stdout.write(`${pkg.version}\n`)
    return
  }

  const folders: string[] = []
  for (const arg of args) {
    try {
      const folder = await realpath(expandPath(arg))
      if (!(await stat(folder)).isDirectory()) throw new Error('not a folder')
      folders.push(folder)
    } catch {
      console.error(`utilitly-mcp: "${arg}" is not a folder. Pass folders to limit what the server may use.`)
      process.exitCode = 2
      return
    }
  }

  // stdout carries the MCP messages, so anything for people goes to stderr.
  const handle = serveStdio(() => createServer({ allowedFolders: folders }))
  process.on('SIGINT', () => void handle.close())
  console.error(folders.length > 0 ? `utilitly-mcp is running; it may only use ${folders.join(', ')}` : 'utilitly-mcp is running')
}

void main()
