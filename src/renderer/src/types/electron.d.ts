type IPCResult<T> =
  | { success: true; data: T }
  | { success: false; error: string }

interface BalanceData {
  assets: number
  voucher_balance: number
  accumulate: number
}

interface InstanceSummary {
  uuid: string
  name: string
  machineId: string
  machineAlias: string
  regionSign: string
  regionName: string
  gpuSpecUuid: string
  requestedGpuAmount: number
  status: string
  subStatus: string
  statusAt: string
  startMode: string
  chargeType: string
  createdAt: string
  startedAt?: string
  stoppedAt?: string
  expiredAt?: string
  timedShutdownAt?: string
  paygPrice: number
}

interface InstanceSnapshot {
  uuid: string
  regionSign: string
  sshCommand: string
  proxyHost: string
  sshPort: number
  rootPassword: string
  jupyterToken: string
  jupyterDomain: string
  gpuAliasName: string
  cpuUsagePercent: number
  memUsagePercent: number
  rootFsUsedSize: number
  rootFsTotalSize: number
  gpuMetrics?: GpuMetric[]
}

interface GpuMetric {
  index: string
  utilizationPercent: number
  memoryUsedMB: number
  memoryTotalMB?: number
  memoryUsagePercent?: number
}

interface MonitorSettings {
  pollIntervalSeconds: number
  notifyOnStatusChange: boolean
  notifyOnPowerOnSuccess: boolean
}

interface MonitorState {
  running: boolean
  polling: boolean
  settings: MonitorSettings
  lastPollAt: string | null
  lastError: string | null
  notificationSupported: boolean
  knownInstanceCount: number
}

interface MonitorStatusChange {
  uuid: string
  name: string
  previousStatus: string
  previousSubStatus: string
  currentStatus: string
  currentSubStatus: string
}

type MonitorEvent =
  | {
      type: 'poll-success'
      at: string
      instances: InstanceSummary[]
      changes: MonitorStatusChange[]
      state: MonitorState
    }
  | {
      type: 'poll-error'
      at: string
      error: string
      state: MonitorState
    }
  | {
      type: 'status-change'
      at: string
      change: MonitorStatusChange
      state: MonitorState
    }
  | {
      type: 'power-on-success'
      at: string
      uuid: string
      instanceName: string
      state: MonitorState
    }

interface TerminalConnectOptions {
  cols?: number
  rows?: number
  sessionId?: string
}

interface TerminalSessionInfo {
  sessionId: string
}

interface TerminalDataEvent {
  sessionId: string
  data: string
}

interface TerminalStatusEvent {
  sessionId: string
  status: 'connecting' | 'connected' | 'closed' | 'error'
  message?: string
}

interface UploadFileInput {
  path: string
  name?: string
}

interface UploadRequest {
  uuid: string
  remoteDir: string
  files: UploadFileInput[]
  uploadId: string
}

interface UploadProgressEvent {
  uploadId: string
  fileName: string
  transferred: number
  total: number
}

interface UploadedFileResult {
  localPath: string
  remotePath: string
  size: number
}

interface UploadResult {
  remoteDir: string
  files: UploadedFileResult[]
}

interface ElectronAPI {
  platform: string
  versions: { node: string; electron: string }

  setToken: (token: string, cookie?: string) => Promise<IPCResult<void>>
  hasToken: () => Promise<boolean>
  clearToken: () => Promise<IPCResult<void>>
  getBalance: () => Promise<IPCResult<BalanceData>>
  listInstances: () => Promise<IPCResult<InstanceSummary[]>>
  getInstanceStatus: (uuid: string) => Promise<IPCResult<string>>
  getInstanceSnapshot: (uuid: string) => Promise<IPCResult<InstanceSnapshot>>
  powerOn: (uuid: string, instanceName?: string) => Promise<IPCResult<null>>
  powerOff: (uuid: string) => Promise<IPCResult<null>>
  getMonitorState: () => Promise<IPCResult<MonitorState>>
  updateMonitorSettings: (
    settings: Partial<MonitorSettings>,
  ) => Promise<IPCResult<MonitorState>>
  startMonitor: () => Promise<IPCResult<MonitorState>>
  stopMonitor: () => Promise<IPCResult<MonitorState>>
  pollMonitorNow: () => Promise<IPCResult<MonitorState>>
  onMonitorEvent: (callback: (event: MonitorEvent) => void) => () => void
  openExternal: (url: string) => Promise<boolean>
  loginViaBrowser: () => Promise<IPCResult<void>>
  connectTerminal: (
    uuid: string,
    options: TerminalConnectOptions,
  ) => Promise<IPCResult<TerminalSessionInfo>>
  sendTerminalInput: (sessionId: string, data: string) => Promise<IPCResult<void>>
  resizeTerminal: (sessionId: string, cols: number, rows: number) => Promise<IPCResult<void>>
  disconnectTerminal: (sessionId: string) => Promise<IPCResult<void>>
  onTerminalData: (callback: (event: TerminalDataEvent) => void) => () => void
  onTerminalStatus: (callback: (event: TerminalStatusEvent) => void) => () => void
  uploadFiles: (request: UploadRequest) => Promise<IPCResult<UploadResult>>
  onUploadProgress: (callback: (event: UploadProgressEvent) => void) => () => void
  getPathForFile: (file: File) => string
}

interface Window {
  electronAPI: ElectronAPI
}
