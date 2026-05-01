import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { MonitorEvent, MonitorSettings, MonitorState } from '../main/services/monitor'
import type {
  TerminalConnectOptions,
  TerminalDataEvent,
  TerminalSessionInfo,
  TerminalStatusEvent,
  UploadProgressEvent,
  UploadRequest,
  UploadResult,
} from '../main/services/ssh'

type IPCResult<T> =
  | { success: true; data: T }
  | { success: false; error: string }

const api = {
  setToken: (token: string, cookie?: string): Promise<IPCResult<void>> =>
    ipcRenderer.invoke('token:set', token, cookie),
  hasToken: (): Promise<boolean> =>
    ipcRenderer.invoke('token:has'),
  clearToken: (): Promise<IPCResult<void>> =>
    ipcRenderer.invoke('token:clear'),

  getBalance: () =>
    ipcRenderer.invoke('api:balance'),
  listInstances: () =>
    ipcRenderer.invoke('api:instances'),
  getInstanceStatus: (uuid: string) =>
    ipcRenderer.invoke('api:instance-status', uuid),
  getInstanceSnapshot: (uuid: string) =>
    ipcRenderer.invoke('api:instance-snapshot', uuid),
  powerOn: (uuid: string, instanceName?: string) =>
    ipcRenderer.invoke('api:power-on', uuid, instanceName),
  powerOff: (uuid: string) =>
    ipcRenderer.invoke('api:power-off', uuid),

  getMonitorState: (): Promise<IPCResult<MonitorState>> =>
    ipcRenderer.invoke('monitor:get-state'),
  updateMonitorSettings: (
    settings: Partial<MonitorSettings>,
  ): Promise<IPCResult<MonitorState>> =>
    ipcRenderer.invoke('monitor:update-settings', settings),
  startMonitor: (): Promise<IPCResult<MonitorState>> =>
    ipcRenderer.invoke('monitor:start'),
  stopMonitor: (): Promise<IPCResult<MonitorState>> =>
    ipcRenderer.invoke('monitor:stop'),
  pollMonitorNow: (): Promise<IPCResult<MonitorState>> =>
    ipcRenderer.invoke('monitor:poll-now'),
  onMonitorEvent: (callback: (event: MonitorEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: MonitorEvent): void => {
      callback(payload)
    }
    ipcRenderer.on('monitor:event', listener)
    return () => ipcRenderer.removeListener('monitor:event', listener)
  },

  openExternal: (url: string): Promise<boolean> =>
    ipcRenderer.invoke('shell:open-external', url),

  loginViaBrowser: (): Promise<IPCResult<void>> =>
    ipcRenderer.invoke('auth:login'),

  connectTerminal: (
    uuid: string,
    options: TerminalConnectOptions,
  ): Promise<IPCResult<TerminalSessionInfo>> =>
    ipcRenderer.invoke('terminal:connect', uuid, options),
  sendTerminalInput: (sessionId: string, data: string): Promise<IPCResult<void>> =>
    ipcRenderer.invoke('terminal:input', sessionId, data),
  resizeTerminal: (
    sessionId: string,
    cols: number,
    rows: number,
  ): Promise<IPCResult<void>> =>
    ipcRenderer.invoke('terminal:resize', sessionId, cols, rows),
  disconnectTerminal: (sessionId: string): Promise<IPCResult<void>> =>
    ipcRenderer.invoke('terminal:disconnect', sessionId),
  onTerminalData: (callback: (event: TerminalDataEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: TerminalDataEvent): void => {
      callback(payload)
    }
    ipcRenderer.on('terminal:data', listener)
    return () => ipcRenderer.removeListener('terminal:data', listener)
  },
  onTerminalStatus: (callback: (event: TerminalStatusEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: TerminalStatusEvent): void => {
      callback(payload)
    }
    ipcRenderer.on('terminal:status', listener)
    return () => ipcRenderer.removeListener('terminal:status', listener)
  },

  uploadFiles: (request: UploadRequest): Promise<IPCResult<UploadResult>> =>
    ipcRenderer.invoke('sftp:upload', request),
  onUploadProgress: (callback: (event: UploadProgressEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: UploadProgressEvent): void => {
      callback(payload)
    }
    ipcRenderer.on('sftp:upload-progress', listener)
    return () => ipcRenderer.removeListener('sftp:upload-progress', listener)
  },
  getPathForFile: (file: Parameters<typeof webUtils.getPathForFile>[0]): string =>
    webUtils.getPathForFile(file),
}

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  versions: {
    node: process.versions.node,
    electron: process.versions.electron,
  },
  ...api,
})
