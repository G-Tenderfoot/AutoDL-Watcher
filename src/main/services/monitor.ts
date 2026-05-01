import { app, Notification } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import type { InstanceSummary } from '../api/types'

const DEFAULT_SETTINGS: MonitorSettings = {
  pollIntervalSeconds: 60,
  notifyOnStatusChange: true,
  notifyOnPowerOnSuccess: true,
}

const MIN_POLL_INTERVAL_SECONDS = 15
const MAX_POLL_INTERVAL_SECONDS = 3600

export interface MonitorSettings {
  pollIntervalSeconds: number
  notifyOnStatusChange: boolean
  notifyOnPowerOnSuccess: boolean
}

export interface MonitorState {
  running: boolean
  polling: boolean
  settings: MonitorSettings
  lastPollAt: string | null
  lastError: string | null
  notificationSupported: boolean
  knownInstanceCount: number
}

export interface MonitorStatusChange {
  uuid: string
  name: string
  previousStatus: string
  previousSubStatus: string
  currentStatus: string
  currentSubStatus: string
}

export type MonitorEvent =
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

type KnownInstanceState = Pick<InstanceSummary, 'uuid' | 'name' | 'status' | 'subStatus'>

function getSettingsPath(): string {
  return join(app.getPath('userData'), 'monitor-settings.json')
}

function normalizePollInterval(value: unknown): number {
  const parsed = Math.round(Number(value))
  if (!Number.isFinite(parsed)) return DEFAULT_SETTINGS.pollIntervalSeconds
  return Math.min(Math.max(parsed, MIN_POLL_INTERVAL_SECONDS), MAX_POLL_INTERVAL_SECONDS)
}

function normalizeSettings(value: Partial<MonitorSettings>): MonitorSettings {
  return {
    pollIntervalSeconds: normalizePollInterval(value.pollIntervalSeconds),
    notifyOnStatusChange:
      typeof value.notifyOnStatusChange === 'boolean'
        ? value.notifyOnStatusChange
        : DEFAULT_SETTINGS.notifyOnStatusChange,
    notifyOnPowerOnSuccess:
      typeof value.notifyOnPowerOnSuccess === 'boolean'
        ? value.notifyOnPowerOnSuccess
        : DEFAULT_SETTINGS.notifyOnPowerOnSuccess,
  }
}

function loadSettings(): MonitorSettings {
  try {
    const path = getSettingsPath()
    if (!existsSync(path)) return { ...DEFAULT_SETTINGS }
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<MonitorSettings>
    return normalizeSettings({ ...DEFAULT_SETTINGS, ...raw })
  } catch (err) {
    console.log('[Monitor] failed to load settings:', (err as Error).message)
    return { ...DEFAULT_SETTINGS }
  }
}

function saveSettings(settings: MonitorSettings): void {
  const path = getSettingsPath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(settings, null, 2), 'utf8')
}

function statusSignature(instance: KnownInstanceState): string {
  return `${instance.status || ''}\n${instance.subStatus || ''}`
}

function formatStatus(status: string, subStatus: string): string {
  const parts = [status, subStatus].filter((part) => part && part.trim())
  return parts.length > 0 ? parts.join(' / ') : '未知'
}

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return '未知错误'
}

export class MonitorService {
  private settings = loadSettings()
  private timer: ReturnType<typeof setInterval> | null = null
  private polling = false
  private lastPollAt: string | null = null
  private lastError: string | null = null
  private knownInstances = new Map<string, KnownInstanceState>()

  constructor(
    private readonly listInstances: () => Promise<InstanceSummary[]>,
    private readonly emitEvent: (event: MonitorEvent) => void,
  ) {}

  getState(): MonitorState {
    return {
      running: this.timer !== null,
      polling: this.polling,
      settings: { ...this.settings },
      lastPollAt: this.lastPollAt,
      lastError: this.lastError,
      notificationSupported: Notification.isSupported(),
      knownInstanceCount: this.knownInstances.size,
    }
  }

  updateSettings(update: Partial<MonitorSettings>): MonitorState {
    this.settings = normalizeSettings({ ...this.settings, ...update })
    saveSettings(this.settings)
    if (this.timer) this.schedule()
    return this.getState()
  }

  start(): MonitorState {
    if (!this.timer) {
      this.schedule()
      void this.poll()
    }
    return this.getState()
  }

  stop(): MonitorState {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    return this.getState()
  }

  reset(): void {
    this.stop()
    this.knownInstances.clear()
    this.lastPollAt = null
    this.lastError = null
  }

  async pollNow(): Promise<MonitorState> {
    await this.poll()
    return this.getState()
  }

  notifyPowerOnSuccess(uuid: string, instanceName?: string): void {
    if (!this.settings.notifyOnPowerOnSuccess) return
    const name = instanceName || this.knownInstances.get(uuid)?.name || uuid.slice(0, 8)

    this.notify({
      title: 'AutoDL 有卡开机成功',
      body: `${name} 已成功提交有卡开机请求。`,
    })

    this.emitEvent({
      type: 'power-on-success',
      at: new Date().toISOString(),
      uuid,
      instanceName: name,
      state: this.getState(),
    })
  }

  private schedule(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = setInterval(() => {
      void this.poll()
    }, this.settings.pollIntervalSeconds * 1000)
  }

  private async poll(): Promise<void> {
    if (this.polling) return

    this.polling = true
    try {
      const instances = await this.listInstances()
      const changes = this.findStatusChanges(instances)
      const at = new Date().toISOString()

      this.lastPollAt = at
      this.lastError = null
      this.replaceKnownInstances(instances)
      this.polling = false

      this.emitEvent({
        type: 'poll-success',
        at,
        instances,
        changes,
        state: this.getState(),
      })

      if (this.settings.notifyOnStatusChange) {
        for (const change of changes) {
          this.notifyStatusChange(change)
          this.emitEvent({
            type: 'status-change',
            at,
            change,
            state: this.getState(),
          })
        }
      }
    } catch (err) {
      const message = getErrorMessage(err)
      const at = new Date().toISOString()
      this.lastError = message
      this.polling = false
      this.emitEvent({
        type: 'poll-error',
        at,
        error: message,
        state: this.getState(),
      })
    } finally {
      this.polling = false
    }
  }

  private findStatusChanges(instances: InstanceSummary[]): MonitorStatusChange[] {
    const changes: MonitorStatusChange[] = []

    for (const instance of instances) {
      const previous = this.knownInstances.get(instance.uuid)
      if (!previous) continue
      if (statusSignature(previous) === statusSignature(instance)) continue

      changes.push({
        uuid: instance.uuid,
        name: instance.name || previous.name || instance.uuid.slice(0, 8),
        previousStatus: previous.status || '',
        previousSubStatus: previous.subStatus || '',
        currentStatus: instance.status || '',
        currentSubStatus: instance.subStatus || '',
      })
    }

    return changes
  }

  private replaceKnownInstances(instances: InstanceSummary[]): void {
    this.knownInstances = new Map(
      instances.map((instance) => [
        instance.uuid,
        {
          uuid: instance.uuid,
          name: instance.name,
          status: instance.status,
          subStatus: instance.subStatus,
        },
      ]),
    )
  }

  private notifyStatusChange(change: MonitorStatusChange): void {
    const previous = formatStatus(change.previousStatus, change.previousSubStatus)
    const current = formatStatus(change.currentStatus, change.currentSubStatus)

    this.notify({
      title: 'AutoDL 实例状态变化',
      body: `${change.name}: ${previous} -> ${current}`,
    })
  }

  private notify({ title, body }: { title: string; body: string }): void {
    if (!Notification.isSupported()) return
    const notification = new Notification({ title, body, silent: false })
    notification.show()
  }
}
