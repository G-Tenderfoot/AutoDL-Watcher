import { BrowserWindow, ipcMain, shell } from 'electron'
import { AutoDLClient, AutoDLAPIError } from './api/client'
import { saveAuth, loadAuth, hasToken, clearToken, isEncryptionAvailable } from './services/token'
import { openAuthWindow } from './services/auth-window'
import { MonitorService } from './services/monitor'
import { SSHService } from './services/ssh'
import type {
  BalanceData,
  InstanceSummary,
  InstanceStatusData,
  InstanceSnapshot,
  PowerOnData,
  PowerOffData,
} from './api/types'
import type { MonitorEvent, MonitorSettings, MonitorState } from './services/monitor'
import type {
  TerminalConnectOptions,
  TerminalSessionInfo,
  UploadRequest,
  UploadResult,
} from './services/ssh'

type IPCResult<T> = { success: true; data: T } | { success: false; error: string }

function ok<T>(data: T): IPCResult<T> {
  return { success: true, data }
}

function fail<T>(error: string): IPCResult<T> {
  return { success: false, error }
}

// Singletons — client is cached so snapshot cache survives between calls
let _client: AutoDLClient | null = null
let _monitor: MonitorService | null = null
let _ssh: SSHService | null = null

function getClient(): AutoDLClient {
  if (_client) return _client
  const auth = loadAuth()
  if (!auth) throw new AutoDLAPIError('NoToken', '未设置 AutoDL Token，请先在应用中输入 Token')
  _client = new AutoDLClient(auth.token, auth.cookie)
  return _client
}

function resetClient(): void {
  _client = null
}

function getSSHService(): SSHService {
  if (_ssh) return _ssh
  _ssh = new SSHService(async (uuid) => getClient().getInstanceSnapshot(uuid))
  return _ssh
}

function closeSSHService(): void {
  _ssh?.closeAll()
}

function broadcastMonitorEvent(event: MonitorEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('monitor:event', event)
    }
  }
}

function getMonitorService(): MonitorService {
  if (_monitor) return _monitor
  _monitor = new MonitorService(
    async () => getClient().listInstances(),
    broadcastMonitorEvent,
  )
  return _monitor
}

function handleError(err: unknown, endpoint?: string): IPCResult<never> {
  if (err instanceof AutoDLAPIError) {
    const ep = err.endpoint ?? endpoint ?? ''
    const prefix = ep ? `[${ep}] ` : ''
    return fail(prefix + err.message)
  }
  if (err instanceof Error) {
    return fail(err.message)
  }
  return fail('未知错误')
}

export function registerIpcHandlers(): void {
  // ── Token ──
  ipcMain.handle('token:set', (_e, token: string, cookie: string): IPCResult<void> => {
    try {
      if (!token || typeof token !== 'string' || !token.trim()) {
        return fail('Token 不能为空')
      }
      if (!isEncryptionAvailable()) {
        return fail('系统加密服务不可用，无法安全存储 Token')
      }
      saveAuth(token.trim(), (cookie || '').trim())
      closeSSHService()
      resetClient()
      getMonitorService().reset()
      return ok(undefined)
    } catch (err) {
      return handleError(err)
    }
  })

  ipcMain.handle('token:has', (): boolean => {
    return hasToken()
  })

  ipcMain.handle('token:clear', (): IPCResult<void> => {
    try {
      clearToken()
      closeSSHService()
      resetClient()
      getMonitorService().reset()
      return ok(undefined)
    } catch (err) {
      return handleError(err)
    }
  })

  ipcMain.handle('auth:login', async (): Promise<IPCResult<void>> => {
    try {
      const auth = await openAuthWindow()
      if (!auth.jwt || typeof auth.jwt !== 'string' || !auth.jwt.trim()) {
        return fail('未能获取到 AutoDL 登录凭证')
      }
      if (!isEncryptionAvailable()) {
        return fail('系统加密服务不可用，无法安全存储凭证')
      }
      saveAuth(auth.jwt.trim(), (auth.cookie || '').trim())
      closeSSHService()
      resetClient()
      getMonitorService().reset()
      return ok(undefined)
    } catch (err) {
      return handleError(err)
    }
  })

  // ── API ──
  ipcMain.handle('api:balance', async (): Promise<IPCResult<BalanceData>> => {
    try {
      const client = getClient()
      const data = await client.getBalance()
      return ok(data)
    } catch (err) {
      return handleError(err)
    }
  })

  ipcMain.handle('api:instances', async (): Promise<IPCResult<InstanceSummary[]>> => {
    try {
      const client = getClient()
      const data = await client.listInstances()
      return ok(data)
    } catch (err) {
      return handleError(err)
    }
  })

  ipcMain.handle(
    'api:instance-status',
    async (_e, uuid: string): Promise<IPCResult<InstanceStatusData>> => {
      try {
        const client = getClient()
        const data = await client.getInstanceStatus(uuid)
        return ok(data)
      } catch (err) {
        return handleError(err)
      }
    },
  )

  ipcMain.handle(
    'api:instance-snapshot',
    async (_e, uuid: string): Promise<IPCResult<InstanceSnapshot>> => {
      try {
        const client = getClient()
        const data = await client.getInstanceSnapshot(uuid)
        return ok(data)
      } catch (err) {
        return handleError(err)
      }
    },
  )

  ipcMain.handle(
    'api:power-on',
    async (_e, uuid: string, instanceName?: string): Promise<IPCResult<PowerOnData>> => {
      try {
        const client = getClient()
        const data = await client.powerOn(uuid)
        const monitor = getMonitorService()
        monitor.notifyPowerOnSuccess(uuid, instanceName)
        void monitor.pollNow()
        return ok(data)
      } catch (err) {
        return handleError(err)
      }
    },
  )

  ipcMain.handle(
    'api:power-off',
    async (_e, uuid: string): Promise<IPCResult<PowerOffData>> => {
      try {
        const client = getClient()
        const data = await client.powerOff(uuid)
        return ok(data)
      } catch (err) {
        return handleError(err)
      }
    },
  )

  ipcMain.handle('shell:open-external', async (_e, url: string): Promise<boolean> => {
    if (/^https?:\/\//i.test(url)) {
      await shell.openExternal(url)
      return true
    }
    return false
  })

  // ── SSH terminal / SFTP upload ──
  ipcMain.handle(
    'terminal:connect',
    async (
      event,
      uuid: string,
      options: TerminalConnectOptions = {},
    ): Promise<IPCResult<TerminalSessionInfo>> => {
      try {
        const win = BrowserWindow.fromWebContents(event.sender)
        if (!win || win.isDestroyed()) {
          return fail('窗口已关闭，无法打开终端')
        }
        if (!uuid || typeof uuid !== 'string') {
          return fail('实例 UUID 不能为空')
        }
        const data = await getSSHService().openTerminal(win, uuid, options)
        return ok(data)
      } catch (err) {
        return handleError(err)
      }
    },
  )

  ipcMain.handle('terminal:input', (_e, sessionId: string, data: string): IPCResult<void> => {
    try {
      getSSHService().writeTerminal(sessionId, data)
      return ok(undefined)
    } catch (err) {
      return handleError(err)
    }
  })

  ipcMain.handle(
    'terminal:resize',
    (_e, sessionId: string, cols: number, rows: number): IPCResult<void> => {
      try {
        getSSHService().resizeTerminal(sessionId, cols, rows)
        return ok(undefined)
      } catch (err) {
        return handleError(err)
      }
    },
  )

  ipcMain.handle('terminal:disconnect', (_e, sessionId: string): IPCResult<void> => {
    try {
      getSSHService().closeTerminal(sessionId)
      return ok(undefined)
    } catch (err) {
      return handleError(err)
    }
  })

  ipcMain.handle(
    'sftp:upload',
    async (event, request: UploadRequest): Promise<IPCResult<UploadResult>> => {
      try {
        const win = BrowserWindow.fromWebContents(event.sender)
        if (!win || win.isDestroyed()) {
          return fail('窗口已关闭，无法上传文件')
        }
        if (!request || !request.uuid) {
          return fail('实例 UUID 不能为空')
        }
        const data = await getSSHService().uploadFiles(win, request)
        return ok(data)
      } catch (err) {
        return handleError(err)
      }
    },
  )

  // ── Monitor ──
  ipcMain.handle('monitor:get-state', (): IPCResult<MonitorState> => {
    try {
      return ok(getMonitorService().getState())
    } catch (err) {
      return handleError(err)
    }
  })

  ipcMain.handle(
    'monitor:update-settings',
    (_e, settings: Partial<MonitorSettings>): IPCResult<MonitorState> => {
      try {
        const state = getMonitorService().updateSettings(settings || {})
        return ok(state)
      } catch (err) {
        return handleError(err)
      }
    },
  )

  ipcMain.handle('monitor:start', (): IPCResult<MonitorState> => {
    try {
      getClient()
      return ok(getMonitorService().start())
    } catch (err) {
      return handleError(err)
    }
  })

  ipcMain.handle('monitor:stop', (): IPCResult<MonitorState> => {
    try {
      return ok(getMonitorService().stop())
    } catch (err) {
      return handleError(err)
    }
  })

  ipcMain.handle('monitor:poll-now', async (): Promise<IPCResult<MonitorState>> => {
    try {
      getClient()
      const state = await getMonitorService().pollNow()
      return ok(state)
    } catch (err) {
      return handleError(err)
    }
  })
}
