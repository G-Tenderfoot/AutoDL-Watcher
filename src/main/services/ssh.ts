import { BrowserWindow } from 'electron'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { posix as posixPath } from 'node:path'
import type {
  Client,
  ClientChannel,
  ConnectConfig,
  SFTPWrapper,
  TransferOptions,
} from 'ssh2'
import type { InstanceSnapshot } from '../api/types'

export interface TerminalConnectOptions {
  cols?: number
  rows?: number
  sessionId?: string
}

export interface TerminalSessionInfo {
  sessionId: string
}

export interface TerminalDataEvent {
  sessionId: string
  data: string
}

export interface TerminalStatusEvent {
  sessionId: string
  status: 'connecting' | 'connected' | 'closed' | 'error'
  message?: string
}

export interface UploadFileInput {
  path: string
  name?: string
}

export interface UploadRequest {
  uuid: string
  remoteDir: string
  files: UploadFileInput[]
  uploadId: string
}

export interface UploadProgressEvent {
  uploadId: string
  fileName: string
  transferred: number
  total: number
}

export interface UploadedFileResult {
  localPath: string
  remotePath: string
  size: number
}

export interface UploadResult {
  remoteDir: string
  files: UploadedFileResult[]
}

type SnapshotResolver = (uuid: string) => Promise<InstanceSnapshot>

interface TerminalSession {
  id: string
  windowId: number
  client: Client
  stream?: ClientChannel
}

interface ResolvedUploadFile {
  localPath: string
  remoteName: string
  size: number
}

type SSH2Runtime = typeof import('ssh2')

const runtimeRequire = createRequire(__filename) as (id: string) => SSH2Runtime
let ssh2Runtime: SSH2Runtime | null = null

function getSSH2(): SSH2Runtime {
  if (!ssh2Runtime) {
    ssh2Runtime = runtimeRequire('ssh2')
  }
  return ssh2Runtime
}

export class SSHService {
  private sessions = new Map<string, TerminalSession>()

  constructor(private readonly resolveSnapshot: SnapshotResolver) {}

  async openTerminal(
    win: BrowserWindow,
    uuid: string,
    options: TerminalConnectOptions,
  ): Promise<TerminalSessionInfo> {
    const snapshot = await this.resolveSnapshot(uuid)
    const config = buildConnectConfig(snapshot)
    const sessionId = isSafeSessionId(options.sessionId) ? options.sessionId : createSessionId()
    const client = new (getSSH2().Client)()
    const session: TerminalSession = {
      id: sessionId,
      windowId: win.id,
      client,
    }

    this.sessions.set(sessionId, session)
    this.sendStatus(win, {
      sessionId,
      status: 'connecting',
      message: '正在连接 SSH...',
    })

    win.once('closed', () => this.closeTerminal(sessionId))

    return new Promise<TerminalSessionInfo>((resolve, reject) => {
      let settled = false

      const failBeforeReady = (err: Error): void => {
        this.sessions.delete(sessionId)
        settled = true
        this.sendStatus(win, {
          sessionId,
          status: 'error',
          message: formatSSHError(err),
        })
        client.end()
        reject(new Error(formatSSHError(err)))
      }

      client
        .once('ready', () => {
          const cols = normalizeDimension(options.cols, 100)
          const rows = normalizeDimension(options.rows, 30)

          client.shell(
            {
              cols,
              rows,
              term: 'xterm-256color',
            },
            (err, stream) => {
              if (err) {
                failBeforeReady(err)
                return
              }

              session.stream = stream
              stream.on('data', (chunk: Buffer | string) => {
                this.sendData(win, {
                  sessionId,
                  data: typeof chunk === 'string' ? chunk : chunk.toString('utf8'),
                })
              })
              stream.stderr.on('data', (chunk: Buffer | string) => {
                this.sendData(win, {
                  sessionId,
                  data: typeof chunk === 'string' ? chunk : chunk.toString('utf8'),
                })
              })
              stream.once('close', () => client.end())

              settled = true
              this.sendStatus(win, {
                sessionId,
                status: 'connected',
                message: 'SSH 已连接',
              })
              resolve({ sessionId })
            },
          )
        })
        .on('error', (err) => {
          if (!settled) {
            failBeforeReady(err)
            return
          }

          this.sendStatus(win, {
            sessionId,
            status: 'error',
            message: formatSSHError(err),
          })
        })
        .once('close', () => {
          this.sessions.delete(sessionId)
          this.sendStatus(win, {
            sessionId,
            status: 'closed',
            message: 'SSH 连接已关闭',
          })
        })

      client.connect(config)
    })
  }

  writeTerminal(sessionId: string, data: string): void {
    const session = this.getSession(sessionId)
    session.stream?.write(data)
  }

  resizeTerminal(sessionId: string, cols: number, rows: number): void {
    const session = this.getSession(sessionId)
    if (!session.stream) return
    session.stream.setWindow(normalizeDimension(rows, 30), normalizeDimension(cols, 100), 0, 0)
  }

  closeTerminal(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    this.sessions.delete(sessionId)
    session.stream?.close()
    session.client.end()
  }

  closeAll(): void {
    for (const sessionId of this.sessions.keys()) {
      this.closeTerminal(sessionId)
    }
  }

  async uploadFiles(win: BrowserWindow, request: UploadRequest): Promise<UploadResult> {
    const snapshot = await this.resolveSnapshot(request.uuid)
    const config = buildConnectConfig(snapshot)
    const remoteDir = normalizeRemoteDir(request.remoteDir)
    const files = await resolveUploadFiles(request.files)

    if (files.length === 0) {
      throw new Error('请选择要上传的文件')
    }

    const client = await connect(config)
    try {
      const sftp = await openSftp(client)
      try {
        await ensureRemoteDir(sftp, remoteDir)
        const uploaded: UploadedFileResult[] = []

        for (const file of files) {
          const remotePath = posixPath.join(remoteDir, file.remoteName)
          await fastPutWithProgress(sftp, file, remotePath, (event) => {
            this.sendUploadProgress(win, {
              uploadId: request.uploadId,
              ...event,
            })
          })
          uploaded.push({
            localPath: file.localPath,
            remotePath,
            size: file.size,
          })
        }

        return {
          remoteDir,
          files: uploaded,
        }
      } finally {
        sftp.end()
      }
    } finally {
      client.end()
    }
  }

  private getSession(sessionId: string): TerminalSession {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error('终端会话不存在或已关闭')
    }
    return session
  }

  private sendData(win: BrowserWindow, event: TerminalDataEvent): void {
    if (!win.isDestroyed()) {
      win.webContents.send('terminal:data', event)
    }
  }

  private sendStatus(win: BrowserWindow, event: TerminalStatusEvent): void {
    if (!win.isDestroyed()) {
      win.webContents.send('terminal:status', event)
    }
  }

  private sendUploadProgress(win: BrowserWindow, event: UploadProgressEvent): void {
    if (!win.isDestroyed()) {
      win.webContents.send('sftp:upload-progress', event)
    }
  }
}

function buildConnectConfig(snapshot: InstanceSnapshot): ConnectConfig {
  if (!snapshot.proxyHost || !snapshot.sshPort || !snapshot.rootPassword) {
    throw new Error('实例缺少 SSH 主机、端口或密码，请等待实例运行并刷新详情')
  }

  return {
    host: snapshot.proxyHost,
    port: snapshot.sshPort,
    username: 'root',
    password: snapshot.rootPassword,
    readyTimeout: 20000,
    keepaliveInterval: 15000,
    keepaliveCountMax: 3,
  }
}

function createSessionId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function isSafeSessionId(value: string | undefined): value is string {
  return typeof value === 'string' && /^[a-z0-9_-]{8,80}$/i.test(value)
}

function normalizeDimension(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || !value) return fallback
  return Math.max(2, Math.round(value))
}

function formatSSHError(err: Error): string {
  if (/timed out/i.test(err.message)) return 'SSH 连接超时，请确认实例已运行且 SSH 信息有效'
  if (/authentication/i.test(err.message)) return 'SSH 认证失败，请刷新实例详情后重试'
  return err.message || 'SSH 连接失败'
}

function connect(config: ConnectConfig): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new (getSSH2().Client)()
    client
      .once('ready', () => resolve(client))
      .once('error', (err) => {
        client.end()
        reject(new Error(formatSSHError(err)))
      })
      .connect(config)
  })
}

function openSftp(client: Client): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    client.sftp((err, sftp) => {
      if (err) {
        reject(err)
        return
      }
      resolve(sftp)
    })
  })
}

function normalizeRemoteDir(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) throw new Error('远端目录不能为空')
  if (trimmed.includes('\0')) throw new Error('远端目录包含无效字符')
  if (!trimmed.startsWith('/')) throw new Error('远端目录必须使用绝对路径，例如 /root/autodl-tmp')
  return posixPath.normalize(trimmed)
}

async function resolveUploadFiles(files: UploadFileInput[]): Promise<ResolvedUploadFile[]> {
  const resolved: ResolvedUploadFile[] = []

  for (const file of files) {
    const localPath = file.path.trim()
    if (!localPath) continue

    const stats = await fs.stat(localPath)
    if (!stats.isFile()) {
      throw new Error(`${localPath} 不是普通文件，暂不支持上传目录`)
    }

    resolved.push({
      localPath,
      remoteName: sanitizeRemoteFileName(file.name || path.basename(localPath)),
      size: stats.size,
    })
  }

  return resolved
}

function sanitizeRemoteFileName(name: string): string {
  const baseName = path.basename(name).replace(/[\\/:*?"<>|]/g, '_').trim()
  if (!baseName || baseName === '.' || baseName === '..') {
    throw new Error('文件名无效')
  }
  return baseName
}

async function ensureRemoteDir(sftp: SFTPWrapper, remoteDir: string): Promise<void> {
  const parts = remoteDir.split('/').filter(Boolean)
  let current = '/'

  for (const part of parts) {
    current = current === '/' ? `/${part}` : `${current}/${part}`

    const exists = await remoteDirectoryExists(sftp, current)
    if (exists) continue
    await mkdir(sftp, current)
  }
}

function remoteDirectoryExists(sftp: SFTPWrapper, remotePath: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    sftp.stat(remotePath, (err, stats) => {
      if (err) {
        resolve(false)
        return
      }
      if (!stats.isDirectory()) {
        reject(new Error(`${remotePath} 已存在但不是目录`))
        return
      }
      resolve(true)
    })
  })
}

function mkdir(sftp: SFTPWrapper, remotePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.mkdir(remotePath, (err) => {
      if (err) {
        reject(err)
        return
      }
      resolve()
    })
  })
}

function fastPutWithProgress(
  sftp: SFTPWrapper,
  file: ResolvedUploadFile,
  remotePath: string,
  onProgress: (event: Omit<UploadProgressEvent, 'uploadId'>) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const options: TransferOptions = {
      fileSize: file.size,
      step: (total, _chunk, size) => {
        onProgress({
          fileName: file.remoteName,
          transferred: total,
          total: size || file.size,
        })
      },
    }

    sftp.fastPut(file.localPath, remotePath, options, (err) => {
      if (err) {
        reject(err)
        return
      }
      onProgress({
        fileName: file.remoteName,
        transferred: file.size,
        total: file.size,
      })
      resolve()
    })
  })
}
