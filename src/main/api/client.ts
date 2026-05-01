import axios, { AxiosInstance, AxiosError } from 'axios'
import type {
  ApiResponse,
  AutoPanelResponse,
  AutoPanelMonitorRaw,
  AutoPanelGpuMetricRaw,
  AutoPanelSystemGpuRaw,
  BalanceData,
  GpuMetric,
  InstanceWebRaw,
  InstanceWebListData,
  InstanceSummary,
  InstanceSnapshot,
  InstanceListData,
  InstanceSnapshotRaw,
  InstanceStatusData,
  PowerOnData,
  PowerOffData,
} from './types'
import {
  formatInstanceSummary,
  extractSnapshot,
  formatProSummary,
  formatInstanceSnapshot,
} from './types'

const WEB_BASE_URL = 'https://www.autodl.com'
const PRO_BASE_URL = 'https://api.autodl.com'
const PAGE_SIZE = 50
const AUTOPANEL_MONITOR_WINDOW_SECONDS = 30 * 60
const GPU_MEMORY_TOTAL_KEYS = [
  'memoryTotalMB',
  'memory_total_mb',
  'memory_total',
  'memoryTotal',
  'mem_total',
  'memTotal',
  'total_memory',
  'totalMemory',
  'total_m',
  'm_total',
  'mt',
  'tm',
]
const GPU_MEMORY_PERCENT_KEYS = [
  'memoryUsagePercent',
  'memory_usage_percent',
  'memory_percent',
  'mem_usage_percent',
  'mem_percent',
  'm_percent',
  'mp',
]
const GPU_MEMORY_MODEL_FALLBACKS: Array<[RegExp, number]> = [
  [/\b(?:RTX\s*)?4090D?\b/i, 24 * 1024],
  [/\b(?:RTX\s*)?3090\b/i, 24 * 1024],
  [/\b(?:RTX\s*)?4080\b/i, 16 * 1024],
  [/\bH20\b/i, 96 * 1024],
  [/\b(?:H100|H800)\b/i, 80 * 1024],
  [/\b(?:L40S?|L20|A40)\b/i, 48 * 1024],
  [/\bA10\b/i, 24 * 1024],
  [/\bT4\b/i, 16 * 1024],
]

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function pickNumber(raw: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = toFiniteNumber(raw[key])
    if (value !== undefined) return value
  }
  return undefined
}

function normalizeMemoryMB(value: number | undefined): number | undefined {
  if (value === undefined || value < 0) return undefined
  return value > 1024 * 1024 ? value / (1024 * 1024) : value
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(value, 100))
}

function inferGpuMemoryTotalMB(gpuAliasName?: string): number | undefined {
  if (!gpuAliasName) return undefined

  const explicit = gpuAliasName.match(/(?:^|[^a-z0-9])(\d+(?:\.\d+)?)\s*(?:g|gb|gib)(?:[^a-z0-9]|$)/i)
  if (explicit) return Number(explicit[1]) * 1024

  const fallback = GPU_MEMORY_MODEL_FALLBACKS.find(([pattern]) => pattern.test(gpuAliasName))
  return fallback?.[1]
}

function getSystemGpuIndex(raw: AutoPanelSystemGpuRaw, fallback: number): string {
  return String(raw.i ?? raw.index ?? raw.id ?? fallback)
}

function extractGpuMemoryTotals(data: AutoPanelMonitorRaw | undefined): Map<string, number> {
  const totals = new Map<string, number>()
  for (const [idx, raw] of (data?.sys?.g ?? []).entries()) {
    const memoryTotalMB = normalizeMemoryMB(pickNumber(raw, GPU_MEMORY_TOTAL_KEYS))
    if (memoryTotalMB !== undefined && memoryTotalMB > 0) {
      totals.set(getSystemGpuIndex(raw, idx), memoryTotalMB)
    }
  }
  return totals
}

function sanitizeForLog(obj: unknown): unknown {
  if (typeof obj !== 'object' || obj === null) return obj
  if (Array.isArray(obj)) return obj.map(sanitizeForLog)
  const cleaned: Record<string, unknown> = {}
  const sensitive = [
    'authorization',
    'cookie',
    'jupyter_token',
    'jupyterToken',
    'root_password',
    'rootPassword',
    'token',
  ]
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (sensitive.includes(k) || sensitive.includes(k.toLowerCase())) {
      cleaned[k] = '***'
    } else {
      cleaned[k] = sanitizeForLog(v)
    }
  }
  return cleaned
}

function formatGpuMetric(
  raw: AutoPanelGpuMetricRaw,
  memoryTotals: Map<string, number>,
  inferredMemoryTotalMB?: number,
): GpuMetric | null {
  const utilizationPercent = toFiniteNumber(raw.u)
  const memoryUsedMB = normalizeMemoryMB(toFiniteNumber(raw.m))
  if (utilizationPercent === undefined || memoryUsedMB === undefined) return null

  const index = String(raw.i)
  const rawMemoryTotalMB = normalizeMemoryMB(pickNumber(raw, GPU_MEMORY_TOTAL_KEYS))
  const memoryTotalMB =
    rawMemoryTotalMB && rawMemoryTotalMB > 0
      ? rawMemoryTotalMB
      : memoryTotals.get(index) ?? inferredMemoryTotalMB
  const explicitMemoryPercent = pickNumber(raw, GPU_MEMORY_PERCENT_KEYS)
  const memoryUsagePercent =
    explicitMemoryPercent !== undefined
      ? clampPercent(explicitMemoryPercent)
      : memoryTotalMB && memoryTotalMB > 0
        ? clampPercent((memoryUsedMB / memoryTotalMB) * 100)
        : undefined

  return {
    index,
    utilizationPercent: clampPercent(utilizationPercent),
    memoryUsedMB,
    ...(memoryTotalMB && memoryTotalMB > 0 ? { memoryTotalMB } : {}),
    ...(memoryUsagePercent !== undefined ? { memoryUsagePercent } : {}),
  }
}

function hasGpuMetrics(point: AutoPanelMonitorRaw['nl'][number]): boolean {
  return (point.n?.g?.length ?? 0) > 0
}

function extractGpuMetrics(data: AutoPanelMonitorRaw | undefined, gpuAliasName?: string): GpuMetric[] {
  const points = [...(data?.nl ?? [])]
    .filter(hasGpuMetrics)
    .sort((a, b) => a.t - b.t)

  const latest = points[points.length - 1]
  if (!latest) return []

  const memoryTotals = extractGpuMemoryTotals(data)
  const inferredMemoryTotalMB = inferGpuMemoryTotalMB(gpuAliasName)

  const metrics = (latest.n?.g ?? [])
    .map((raw) => formatGpuMetric(raw, memoryTotals, inferredMemoryTotalMB))
    .filter((metric): metric is GpuMetric => metric !== null)

  return metrics
}

export class AutoDLAPIError extends Error {
  constructor(
    public code: string | null,
    message: string,
    public endpoint?: string,
  ) {
    super(message)
    this.name = 'AutoDLAPIError'
  }
}

function createHttp(baseURL: string, token: string, cookie?: string): AxiosInstance {
  const headers: Record<string, string> = {
    Accept: 'application/json, text/plain, */*',
    Authorization: token,
  }

  // Web API needs Origin + Referer for CSRF
  if (baseURL === WEB_BASE_URL) {
    if (cookie) headers['Cookie'] = cookie
    headers['Origin'] = 'https://www.autodl.com'
    headers['Referer'] = 'https://www.autodl.com/console/instance/list'
    headers['User-Agent'] =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36'
  }

  const http = axios.create({
    baseURL,
    timeout: 15000,
    headers,
  })

  http.interceptors.response.use(
    (res) => {
      const data = res.data as ApiResponse<unknown>
      if (data.code !== 'Success') {
        const ep = res.config.url?.replace(baseURL, '')
        throw new AutoDLAPIError(data.code ?? 'Unknown', data.msg || '未知 API 错误', ep)
      }
      return res
    },
    (err: AxiosError) => {
      const ep = (err.config?.url ?? '').replace(baseURL, '')
      if (err.response) {
        const data = err.response.data as { msg?: string }
        throw new AutoDLAPIError(
          String(err.response.status),
          data?.msg ?? `HTTP ${err.response.status}: 请求失败`,
          ep,
        )
      }
      if (err.code === 'ECONNABORTED') {
        throw new AutoDLAPIError('Timeout', '请求超时，请检查网络连接', ep)
      }
      throw new AutoDLAPIError('Network', `网络错误: ${err.message}`, ep)
    },
  )

  return http
}

export class AutoDLClient {
  private web: AxiosInstance
  private pro: AxiosInstance
  private snapshotCache = new Map<string, InstanceSnapshot>()
  private webListAvailable: boolean | null = null

  constructor(token: string, cookie?: string) {
    this.web = createHttp(WEB_BASE_URL, token, cookie)
    this.pro = createHttp(PRO_BASE_URL, token, cookie)
  }

  // ── Balance ──

  async getBalance(): Promise<BalanceData> {
    // Try web API first, fallback to pro
    try {
      const data = await this.getFrom<BalanceData>(this.web, '/api/v1/wallet/balance', { charge_type: 'payg' })
      console.log('[API] web balance ok')
      return data
    } catch (err) {
      console.log('[API] web balance failed:', (err as Error).message)
      return this.postTo<BalanceData>(this.pro, '/api/v1/dev/wallet/balance')
    }
  }

  // ── Instance list ──

  async listInstances(): Promise<InstanceSummary[]> {
    // Try web API first (richer data), fallback to pro API
    try {
      const instances = await this.listWebInstances()
      this.webListAvailable = true
      return instances
    } catch (err) {
      this.webListAvailable = false
      console.log('[API] web list failed, trying pro:', (err as Error).message)
    }
    return this.listProInstances()
  }

  private async listWebInstances(): Promise<InstanceSummary[]> {
    const result: InstanceSummary[] = []
    this.snapshotCache.clear()

    const data = await this.postTo<InstanceWebListData>(
      this.web,
      '/api/v1/instance',
      { page_index: 1, page_size: PAGE_SIZE },
    )
    console.log('[API] web instances page 1:', JSON.stringify(sanitizeForLog(data)))

    for (const raw of data.list) {
      result.push(formatInstanceSummary(raw))
      this.snapshotCache.set(raw.uuid, extractSnapshot(raw))
    }

    for (let p = 2; p <= data.max_page; p++) {
      const pData = await this.postTo<InstanceWebListData>(
        this.web,
        '/api/v1/instance',
        { page_index: p, page_size: PAGE_SIZE },
      )
      for (const raw of pData.list) {
        result.push(formatInstanceSummary(raw))
        this.snapshotCache.set(raw.uuid, extractSnapshot(raw))
      }
    }

    console.log(`[API] web instances total: ${result.length}`)
    return result
  }

  private async listProInstances(): Promise<InstanceSummary[]> {
    const result: InstanceSummary[] = []
    const data = await this.postTo<InstanceListData>(
      this.pro,
      '/api/v1/dev/instance/pro/list',
      { page_index: 1, page_size: PAGE_SIZE },
    )
    console.log('[API] pro instances page 1:', JSON.stringify(sanitizeForLog(data)))

    for (const raw of data.list) result.push(formatProSummary(raw))

    for (let p = 2; p <= data.max_page; p++) {
      const pData = await this.postTo<InstanceListData>(
        this.pro,
        '/api/v1/dev/instance/pro/list',
        { page_index: p, page_size: PAGE_SIZE },
      )
      for (const raw of pData.list) result.push(formatProSummary(raw))
    }

    console.log(`[API] pro instances total: ${result.length}`)
    return result
  }

  // ── Snapshot ──

  getCachedSnapshot(uuid: string): InstanceSnapshot | undefined {
    return this.snapshotCache.get(uuid)
  }

  async getInstanceSnapshot(uuid: string): Promise<InstanceSnapshot> {
    const refreshed = await this.tryRefreshWebSnapshot(uuid)
    if (refreshed) return this.withGpuMetrics(refreshed)

    try {
      const raw = await this.getFrom<InstanceSnapshotRaw>(
        this.pro,
        '/api/v1/dev/instance/pro/snapshot',
        { instance_uuid: uuid },
      )
      console.log('[API] snapshot received:', sanitizeForLog(raw))
      const snapshot = formatInstanceSnapshot(uuid, raw)
      this.snapshotCache.set(uuid, snapshot)
      return this.withGpuMetrics(snapshot)
    } catch (err) {
      const cached = this.snapshotCache.get(uuid)
      if (cached) return this.withGpuMetrics(cached)
      throw err
    }
  }

  private async tryRefreshWebSnapshot(uuid: string): Promise<InstanceSnapshot | undefined> {
    if (this.webListAvailable === false && !this.snapshotCache.has(uuid)) return undefined

    try {
      const snapshot = await this.refreshWebSnapshot(uuid)
      this.webListAvailable = true
      return snapshot
    } catch (err) {
      console.log('[API] web snapshot refresh skipped:', (err as Error).message)
      return undefined
    }
  }

  private async refreshWebSnapshot(uuid: string): Promise<InstanceSnapshot | undefined> {
    let page = 1
    let maxPage = 1

    do {
      const data = await this.postTo<InstanceWebListData>(
        this.web,
        '/api/v1/instance',
        { page_index: page, page_size: PAGE_SIZE },
      )

      maxPage = Math.max(data.max_page || 1, 1)
      for (const raw of data.list) {
        const snapshot = extractSnapshot(raw)
        this.snapshotCache.set(raw.uuid, snapshot)
        if (raw.uuid === uuid) return snapshot
      }

      page += 1
    } while (page <= maxPage)

    return undefined
  }

  private async withGpuMetrics(snapshot: InstanceSnapshot): Promise<InstanceSnapshot> {
    if (!snapshot.jupyterDomain || !snapshot.jupyterToken) return snapshot

    try {
      const res = await axios.get<AutoPanelResponse<AutoPanelMonitorRaw>>(
        `https://${snapshot.jupyterDomain}/autopanel/v1/monitor`,
        {
          timeout: 5000,
          params: {
            from: Math.floor(Date.now() / 1000) - AUTOPANEL_MONITOR_WINDOW_SECONDS,
          },
          headers: { AutodlAutoPanelToken: snapshot.jupyterToken },
        },
      )

      if (!['success', 'Success'].includes(res.data.code)) {
        console.log('[API] autopanel monitor skipped:', res.data.code, res.data.msg)
        return snapshot
      }

      const gpuMetrics = extractGpuMetrics(res.data.data, snapshot.gpuAliasName)

      return gpuMetrics.length > 0 ? { ...snapshot, gpuMetrics } : snapshot
    } catch (err) {
      console.log('[API] autopanel monitor unavailable:', (err as Error).message)
      return snapshot
    }
  }

  // ── Status ──

  async getInstanceStatus(uuid: string): Promise<InstanceStatusData> {
    return this.getFrom<InstanceStatusData>(
      this.pro,
      '/api/v1/dev/instance/pro/status',
      { instance_uuid: uuid },
    )
  }

  // ── Power ──

  async powerOn(uuid: string): Promise<PowerOnData> {
    try {
      const data = await this.postTo<PowerOnData>(
        this.web,
        '/api/v1/instance/power_on',
        { instance_uuid: uuid, payload: 'gpu' },
      )
      this.snapshotCache.delete(uuid)
      return data
    } catch (err) {
      // If the web list already works, preserve web API business errors such as no GPU stock.
      if (this.webListAvailable !== false) throw err
      const data = await this.postTo<PowerOnData>(
        this.pro,
        '/api/v1/dev/instance/pro/power_on',
        { instance_uuid: uuid, payload: 'gpu' },
      )
      this.snapshotCache.delete(uuid)
      return data
    }
  }

  async powerOff(uuid: string): Promise<PowerOffData> {
    try {
      const data = await this.postTo<PowerOffData>(
        this.web,
        '/api/v1/instance/power_off',
        { instance_uuid: uuid },
      )
      this.snapshotCache.delete(uuid)
      return data
    } catch (err) {
      if (this.webListAvailable !== false) throw err
      const data = await this.postTo<PowerOffData>(
        this.pro,
        '/api/v1/dev/instance/pro/power_off',
        { instance_uuid: uuid },
      )
      this.snapshotCache.delete(uuid)
      return data
    }
  }

  // ── HTTP helpers ──

  private async postTo<T>(client: AxiosInstance, path: string, body?: unknown): Promise<T> {
    const res = await client.post<ApiResponse<T>>(path, body ?? undefined, {
      headers: body != null ? { 'Content-Type': 'application/json' } : undefined,
    })
    return res.data.data
  }

  private async getFrom<T>(client: AxiosInstance, path: string, params?: Record<string, string>): Promise<T> {
    const res = await client.get<ApiResponse<T>>(path, { params })
    return res.data.data
  }
}
