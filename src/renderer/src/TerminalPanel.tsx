import { useCallback, useEffect, useRef, useState } from 'react'
import type { DragEvent } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal as XTerm } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'

type TerminalState = 'idle' | 'connecting' | 'connected' | 'error'
type UploadState = 'idle' | 'uploading' | 'success' | 'error'

interface LocalUploadFile {
  path: string
  name: string
  size: number
}

interface UploadProgressState {
  fileName: string
  transferred: number
  total: number
}

interface TerminalPanelProps {
  instance: InstanceSummary
  snapshot: InstanceSnapshot
  canConnect: boolean
}

const DEFAULT_REMOTE_DIR = '/root/autodl-tmp'

export function TerminalPanel({
  instance,
  snapshot,
  canConnect,
}: TerminalPanelProps): JSX.Element {
  const terminalHostRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<XTerm | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  const uploadIdRef = useRef<string | null>(null)

  const [sessionId, setSessionId] = useState<string | null>(null)
  const [terminalState, setTerminalState] = useState<TerminalState>('idle')
  const [terminalMessage, setTerminalMessage] = useState<string | null>(null)
  const [remoteDir, setRemoteDir] = useState(DEFAULT_REMOTE_DIR)
  const [uploadFiles, setUploadFiles] = useState<LocalUploadFile[]>([])
  const [uploadState, setUploadState] = useState<UploadState>('idle')
  const [uploadMessage, setUploadMessage] = useState<string | null>(null)
  const [uploadProgress, setUploadProgress] = useState<UploadProgressState | null>(null)
  const [dragActive, setDragActive] = useState(false)

  const sshReady = canConnect && Boolean(snapshot.proxyHost && snapshot.sshPort && snapshot.rootPassword)
  const sshBlockedReason = canConnect
    ? '实例缺少 SSH 主机、端口或密码，请刷新详情后重试'
    : '实例运行中后才能连接 SSH'

  const fitAndSyncSize = useCallback(() => {
    const terminal = terminalRef.current
    const fitAddon = fitAddonRef.current
    if (!terminal || !fitAddon || !terminalHostRef.current) return

    fitAddon.fit()
    const currentSessionId = sessionIdRef.current
    if (currentSessionId) {
      void window.electronAPI.resizeTerminal(currentSessionId, terminal.cols, terminal.rows)
    }
  }, [])

  useEffect(() => {
    const terminal = new XTerm({
      cursorBlink: true,
      fontFamily: '"Cascadia Code", "Fira Code", Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.15,
      convertEol: true,
      theme: {
        background: '#070b14',
        foreground: '#d8dee9',
        cursor: '#73c0de',
        selectionBackground: '#2f4777',
      },
    })
    const fitAddon = new FitAddon()

    terminal.loadAddon(fitAddon)
    terminalRef.current = terminal
    fitAddonRef.current = fitAddon

    if (terminalHostRef.current) {
      terminal.open(terminalHostRef.current)
      fitAndSyncSize()
    }

    const dataDisposable = terminal.onData((data) => {
      const currentSessionId = sessionIdRef.current
      if (currentSessionId) {
        void window.electronAPI.sendTerminalInput(currentSessionId, data)
      }
    })

    const resizeObserver = new ResizeObserver(() => fitAndSyncSize())
    if (terminalHostRef.current) {
      resizeObserver.observe(terminalHostRef.current)
    }

    return () => {
      resizeObserver.disconnect()
      dataDisposable.dispose()
      terminal.dispose()
    }
  }, [fitAndSyncSize])

  useEffect(() => {
    return window.electronAPI.onTerminalData((event) => {
      if (event.sessionId === sessionIdRef.current) {
        terminalRef.current?.write(event.data)
      }
    })
  }, [])

  useEffect(() => {
    return window.electronAPI.onTerminalStatus((event) => {
      if (event.sessionId !== sessionIdRef.current) return

      if (event.status === 'closed') {
        sessionIdRef.current = null
        setSessionId(null)
        setTerminalState('idle')
        setTerminalMessage(event.message || 'SSH 连接已关闭')
        return
      }

      if (event.status === 'error') {
        sessionIdRef.current = null
        setSessionId(null)
        setTerminalState('error')
        setTerminalMessage(event.message || 'SSH 连接失败')
        return
      }

      setTerminalState(event.status)
      setTerminalMessage(event.message || null)
    })
  }, [])

  useEffect(() => {
    return window.electronAPI.onUploadProgress((event) => {
      if (event.uploadId === uploadIdRef.current) {
        setUploadProgress({
          fileName: event.fileName,
          transferred: event.transferred,
          total: event.total,
        })
      }
    })
  }, [])

  useEffect(() => {
    return () => {
      const currentSessionId = sessionIdRef.current
      if (currentSessionId) {
        void window.electronAPI.disconnectTerminal(currentSessionId)
      }
    }
  }, [])

  const disconnectTerminal = useCallback(async (showMessage: boolean) => {
    const currentSessionId = sessionIdRef.current
    if (!currentSessionId) return

    sessionIdRef.current = null
    setSessionId(null)
    setTerminalState('idle')
    if (showMessage) setTerminalMessage('SSH 连接已关闭')
    await window.electronAPI.disconnectTerminal(currentSessionId)
  }, [])

  const handleConnectTerminal = async () => {
    if (!sshReady) {
      setTerminalState('error')
      setTerminalMessage(sshBlockedReason)
      return
    }

    await disconnectTerminal(false)
    const nextSessionId = createSessionId()
    sessionIdRef.current = nextSessionId
    setSessionId(nextSessionId)
    setTerminalState('connecting')
    setTerminalMessage('正在连接 SSH...')
    terminalRef.current?.clear()
    terminalRef.current?.writeln(`Connecting to ${snapshot.proxyHost}:${snapshot.sshPort} as root...`)

    const terminal = terminalRef.current
    const res = await window.electronAPI.connectTerminal(instance.uuid, {
      cols: terminal?.cols,
      rows: terminal?.rows,
      sessionId: nextSessionId,
    })

    if (!res.success) {
      sessionIdRef.current = null
      setSessionId(null)
      setTerminalState('error')
      setTerminalMessage(res.error)
      terminalRef.current?.writeln(`\r\n${res.error}`)
      return
    }

    sessionIdRef.current = res.data.sessionId
    setSessionId(res.data.sessionId)
    setTerminalState('connected')
    setTerminalMessage('SSH 已连接')
    fitAndSyncSize()
    terminalRef.current?.focus()
  }

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDragActive(false)
    setUploadState('idle')
    setUploadMessage(null)

    const dropped = Array.from(event.dataTransfer.files)
      .map((file) => {
        const filePath = window.electronAPI.getPathForFile(file)
        if (!filePath) return null
        return {
          path: filePath,
          name: file.name || filePath.split(/[\\/]/).pop() || 'upload-file',
          size: file.size,
        }
      })
      .filter((file): file is LocalUploadFile => file !== null)

    if (dropped.length === 0) {
      setUploadState('error')
      setUploadMessage('没有可上传的本地文件路径')
      return
    }

    setUploadFiles((prev) => {
      const existing = new Set(prev.map((file) => file.path))
      const next = dropped.filter((file) => !existing.has(file.path))
      return [...prev, ...next]
    })
  }

  const handleUpload = async () => {
    if (!sshReady) {
      setUploadState('error')
      setUploadMessage(sshBlockedReason)
      return
    }

    if (uploadFiles.length === 0) {
      setUploadState('error')
      setUploadMessage('请先拖入要上传的文件')
      return
    }

    const uploadId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    uploadIdRef.current = uploadId
    setUploadState('uploading')
    setUploadMessage(null)
    setUploadProgress(null)

    const res = await window.electronAPI.uploadFiles({
      uuid: instance.uuid,
      remoteDir,
      uploadId,
      files: uploadFiles.map((file) => ({
        path: file.path,
        name: file.name,
      })),
    })

    if (!res.success) {
      setUploadState('error')
      setUploadMessage(res.error)
      return
    }

    setUploadState('success')
    setUploadProgress(null)
    setUploadMessage(`${res.data.files.length} 个文件已上传到 ${res.data.remoteDir}`)
  }

  const progressPercent =
    uploadProgress && uploadProgress.total > 0
      ? Math.min(100, Math.round((uploadProgress.transferred / uploadProgress.total) * 100))
      : 0

  return (
    <section className="detail-section terminal-upload-section">
      <h4>终端与文件上传</h4>

      <div className="terminal-card">
        <div className="terminal-toolbar">
          <div className="terminal-meta">
            <span
              className={`terminal-dot ${
                terminalState === 'connected' ? 'connected' : terminalState
              }`}
            />
            <span>
              {sessionId
                ? `root@${snapshot.proxyHost}:${snapshot.sshPort}`
                : snapshot.proxyHost || '未连接'}
            </span>
          </div>
          <div className="terminal-actions">
            <button
              className="btn btn-sm btn-secondary"
              disabled={!sshReady || terminalState === 'connecting' || terminalState === 'connected'}
              onClick={handleConnectTerminal}
              title={sshReady ? '连接 SSH 终端' : sshBlockedReason}
            >
              {terminalState === 'connecting' ? '连接中...' : '连接终端'}
            </button>
            <button
              className="btn btn-sm"
              disabled={!sessionId}
              onClick={() => disconnectTerminal(true)}
            >
              断开
            </button>
          </div>
        </div>
        {terminalMessage && (
          <div className={terminalState === 'error' ? 'terminal-message error' : 'terminal-message'}>
            {terminalMessage}
          </div>
        )}
        <div className="terminal-host" ref={terminalHostRef} />
      </div>

      <div className="upload-panel">
        <label className="upload-field">
          <span>远端目录</span>
          <input
            className="text-input"
            value={remoteDir}
            disabled={uploadState === 'uploading'}
            onChange={(event) => setRemoteDir(event.target.value)}
          />
        </label>

        <div
          className={`drop-zone ${dragActive ? 'drag-active' : ''}`}
          onDragOver={(event) => {
            event.preventDefault()
            setDragActive(true)
          }}
          onDragLeave={() => setDragActive(false)}
          onDrop={handleDrop}
        >
          <span>拖拽文件</span>
          <small>{uploadFiles.length > 0 ? `${uploadFiles.length} 个文件待上传` : '未选择文件'}</small>
        </div>

        {uploadFiles.length > 0 && (
          <div className="upload-list">
            {uploadFiles.map((file) => (
              <div className="upload-list-item" key={file.path} title={file.path}>
                <span>{file.name}</span>
                <small>{formatBytes(file.size)}</small>
              </div>
            ))}
          </div>
        )}

        {uploadProgress && (
          <div className="upload-progress">
            <div className="upload-progress-meta">
              <span>{uploadProgress.fileName}</span>
              <span>{progressPercent}%</span>
            </div>
            <div className="upload-progress-track">
              <div className="upload-progress-fill" style={{ width: `${progressPercent}%` }} />
            </div>
          </div>
        )}

        {uploadMessage && (
          <div className={uploadState === 'success' ? 'success-msg' : 'error-msg'}>
            {uploadMessage}
          </div>
        )}

        <div className="upload-actions">
          <button
            className="btn btn-sm btn-start"
            disabled={!sshReady || uploadState === 'uploading' || uploadFiles.length === 0}
            onClick={handleUpload}
            title={sshReady ? '上传到远端目录' : sshBlockedReason}
          >
            {uploadState === 'uploading' ? '上传中...' : '上传'}
          </button>
          <button
            className="btn btn-sm"
            disabled={uploadState === 'uploading' || uploadFiles.length === 0}
            onClick={() => {
              setUploadFiles([])
              setUploadProgress(null)
              setUploadMessage(null)
              setUploadState('idle')
            }}
          >
            清空
          </button>
        </div>
      </div>
    </section>
  )
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

function createSessionId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}
