import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AddressInfo } from 'node:net'
import { SCENE_GLB } from './render'

const LOOPBACK = '127.0.0.1'

export interface PreviewLaunch {
  url: string
  opened: boolean
  reused: boolean
}

export interface LocalPreviewOptions {
  assetsDir?: string
  port?: number
  openBrowser?: (url: string) => Promise<boolean>
}

export interface LocalPreview {
  show(workdir: string): Promise<PreviewLaunch>
  sceneBuilt(workdir: string): void
  close(): Promise<void>
}

export function createLocalPreview(
  options: LocalPreviewOptions = {},
): LocalPreview {
  let running: PreviewServer | undefined
  let revision = 0
  const openBrowser = options.openBrowser ?? systemOpen

  return {
    async show(workdir) {
      const workspace = resolve(workdir)
      await requireFile(
        join(workspace, SCENE_GLB),
        `No ${SCENE_GLB} exists yet. Build the scene before using /render.`,
      )

      const reused = running?.workdir === workspace
      if (running !== undefined && running.workdir !== workspace) {
        await running.close()
        running = undefined
      }
      if (running === undefined) {
        running = await startServer({
          workdir: workspace,
          assetsDir: resolve(options.assetsDir ?? previewAssetsDir()),
          port: options.port ?? 0,
          revision: () => String(revision),
        })
      }

      const url = `${running.url}/?live=1&build=${revision}`
      return { url, opened: await openBrowser(url), reused }
    },
    sceneBuilt(workdir) {
      if (running === undefined || running.workdir !== resolve(workdir)) return
      revision += 1
      running.reload(String(revision))
    },
    async close() {
      await running?.close()
      running = undefined
    },
  }
}

interface StartServerOptions {
  workdir: string
  assetsDir: string
  port: number
  revision: () => string
}

interface PreviewServer {
  workdir: string
  url: string
  reload(revision: string): void
  close(): Promise<void>
}

async function startServer(
  options: StartServerOptions,
): Promise<PreviewServer> {
  await requireFile(
    join(options.assetsDir, 'index.html'),
    'The local viewer is not packaged. Rebuild the agent before using /render.',
  )
  const clients = new Set<ServerResponse>()
  const server = createServer(async (request, response) => {
    try {
      const method = request.method ?? 'GET'
      if (method !== 'GET' && method !== 'HEAD') {
        response.writeHead(405, { Allow: 'GET, HEAD' }).end()
        return
      }
      const url = new URL(request.url ?? '/', 'http://localhost')
      if (url.pathname === '/events') {
        response.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
        })
        if (method === 'HEAD') {
          response.end()
          return
        }
        response.write(`event: ready\ndata: ${options.revision()}\n\n`)
        clients.add(response)
        response.once('close', () => clients.delete(response))
        return
      }
      if (url.pathname === `/${SCENE_GLB}`) {
        await sendFile(
          join(options.workdir, SCENE_GLB),
          'model/gltf-binary',
          method,
          response,
          'no-store',
        )
        return
      }

      const relative = decodePath(
        url.pathname === '/' ? 'index.html' : url.pathname.slice(1),
      )
      const path = resolve(options.assetsDir, relative)
      if (!inside(options.assetsDir, path)) {
        response.writeHead(404).end()
        return
      }
      await sendFile(
        path,
        contentType(path),
        method,
        response,
        relative === 'index.html'
          ? 'no-cache'
          : 'public, max-age=31536000, immutable',
      )
    } catch (error) {
      const code = errorCode(error)
      if (code === 'ENOENT' || code === 'EISDIR') {
        response.writeHead(404).end()
      } else if (error instanceof URIError) {
        response.writeHead(400).end()
      } else {
        response.writeHead(500).end()
      }
    }
  })

  const port = await listen(server, options.port)
  return {
    workdir: options.workdir,
    url: `http://${LOOPBACK}:${port}`,
    reload(next) {
      for (const client of clients) {
        client.write(`event: reload\ndata: ${next}\n\n`)
      }
    },
    close: () =>
      new Promise<void>((done, reject) => {
        for (const client of clients) client.end()
        clients.clear()
        server.close((error) => (error ? reject(error) : done()))
      }),
  }
}

async function sendFile(
  path: string,
  type: string,
  method: string,
  response: ServerResponse,
  cacheControl: string,
): Promise<void> {
  const contents = await readFile(path)
  response.writeHead(200, {
    'Content-Type': type,
    'Content-Length': contents.byteLength,
    'Cache-Control': cacheControl,
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(method === 'HEAD' ? undefined : contents)
}

function listen(server: Server, preferred: number): Promise<number> {
  return new Promise((done, reject) => {
    const tryPort = (port: number, canFallback: boolean) => {
      const onError = (error: NodeJS.ErrnoException) => {
        server.off('listening', onListening)
        if (canFallback && error.code === 'EADDRINUSE') {
          tryPort(0, false)
        } else {
          reject(error)
        }
      }
      const onListening = () => {
        server.off('error', onError)
        const address = server.address() as AddressInfo
        done(address.port)
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(port, LOOPBACK)
    }
    tryPort(preferred, preferred !== 0)
  })
}

function previewAssetsDir(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url))
  const bundled = join(moduleDir, 'preview')
  const source = resolve(moduleDir, '../../preview/dist')
  return existsSync(join(bundled, 'index.html')) ? bundled : source
}

function decodePath(path: string): string {
  const decoded = decodeURIComponent(path)
  return decoded === '' ? 'index.html' : decoded
}

function inside(root: string, path: string): boolean {
  const base = resolve(root)
  return path === base || path.startsWith(`${base}${sep}`)
}

function contentType(path: string): string {
  const types: Record<string, string> = {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.wasm': 'application/wasm',
  }
  return types[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

async function requireFile(path: string, message: string): Promise<void> {
  const found = await stat(path).catch(() => undefined)
  if (found?.isFile() !== true) throw new Error(message)
}

function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === 'object' && 'code' in error
    ? String(error.code)
    : undefined
}

function systemOpen(url: string): Promise<boolean> {
  const command =
    process.platform === 'darwin'
      ? { file: 'open', args: [url] }
      : process.platform === 'win32'
        ? { file: 'cmd', args: ['/c', 'start', '', url] }
        : { file: 'xdg-open', args: [url] }

  return new Promise((done) => {
    const child = spawn(command.file, command.args, {
      detached: true,
      stdio: 'ignore',
    })
    child.once('error', () => done(false))
    child.once('spawn', () => {
      child.unref()
      done(true)
    })
  })
}
