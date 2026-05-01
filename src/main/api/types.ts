// AutoDL API response wrapper
// code is a string: "Success" on success, error code otherwise
export interface ApiResponse<T> {
  code: string
  msg: string
  data: T
  request_id?: string
}

// Time field: nullable Go time with Valid flag
export interface NullableTime {
  Time: string
  Valid: boolean
}

function formatTime(t: NullableTime | undefined): string | undefined {
  if (!t || !t.Valid) return undefined
  return t.Time
}

// ── Web API (www.autodl.com, JWT auth) ──

// POST /api/v1/instance response item
// Rich response: includes SSH, Jupyter, resource usage inline
export interface InstanceWebRaw {
  uuid: string
  name: string
  machine_id: string
  machine_alias: string
  region_sign: string
  region_name: string
  status: string
  sub_status: string
  status_at: string
  start_mode: string
  charge_type: string
  created_at: string
  started_at: NullableTime
  stopped_at: NullableTime
  expired_at: NullableTime
  timed_shutdown_at: NullableTime
  req_gpu_amount: number
  // SSH
  ssh_command: string
  proxy_host: string
  ssh_port: number
  root_password: string
  // Jupyter
  jupyter_token: string
  jupyter_domain: string
  // GPU info
  snapshot_gpu_alias_name: string
  // Resource usage
  cpu_usage_percent: number
  mem_usage_percent: number
  root_fs_used_size: number
  root_fs_total_size: number
  // Pricing
  payg_price: number
  cpu_limit: number
  mem_limit_in_byte: number
  mem_usage: number
  mem_limit: number
}

export interface AutoPanelResponse<T> {
  code: string
  msg: string
  data: T
}

export interface AutoPanelGpuMetricRaw {
  i: string | number
  m: number | string
  u: number | string
  [key: string]: unknown
}

export interface AutoPanelSystemGpuRaw {
  i?: string | number
  index?: string | number
  id?: string | number
  [key: string]: unknown
}

export interface AutoPanelMonitorRaw {
  nl: Array<{
    t: number
    n?: {
      g?: AutoPanelGpuMetricRaw[]
    }
  }>
  sys?: {
    g_num?: number
    g?: AutoPanelSystemGpuRaw[]
  }
}

export interface InstanceWebListData {
  list: InstanceWebRaw[]
  page_index: number
  page_size: number
  max_page: number
  result_total: number
}

// ── Cleaned types for renderer (camelCase) ──

export interface InstanceSummary {
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

export interface InstanceSnapshot {
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

export interface GpuMetric {
  index: string
  utilizationPercent: number
  memoryUsedMB: number
  memoryTotalMB?: number
  memoryUsagePercent?: number
}

export function formatInstanceSummary(raw: InstanceWebRaw): InstanceSummary {
  return {
    uuid: raw.uuid,
    name: raw.name || raw.uuid.substring(0, 8),
    machineId: raw.machine_id,
    machineAlias: raw.machine_alias,
    regionSign: raw.region_sign,
    regionName: raw.region_name,
    gpuSpecUuid: raw.snapshot_gpu_alias_name,
    requestedGpuAmount: raw.req_gpu_amount,
    status: raw.status,
    subStatus: raw.sub_status,
    statusAt: raw.status_at,
    startMode: raw.start_mode,
    chargeType: raw.charge_type,
    createdAt: raw.created_at,
    startedAt: formatTime(raw.started_at),
    stoppedAt: formatTime(raw.stopped_at),
    expiredAt: formatTime(raw.expired_at),
    timedShutdownAt: formatTime(raw.timed_shutdown_at),
    paygPrice: raw.payg_price,
  }
}

export function extractSnapshot(raw: InstanceWebRaw): InstanceSnapshot {
  return {
    uuid: raw.uuid,
    regionSign: raw.region_sign,
    sshCommand: raw.ssh_command,
    proxyHost: raw.proxy_host,
    sshPort: raw.ssh_port,
    rootPassword: raw.root_password,
    jupyterToken: raw.jupyter_token,
    jupyterDomain: raw.jupyter_domain,
    gpuAliasName: raw.snapshot_gpu_alias_name,
    cpuUsagePercent: raw.cpu_usage_percent,
    memUsagePercent: raw.mem_usage_percent,
    rootFsUsedSize: raw.root_fs_used_size,
    rootFsTotalSize: raw.root_fs_total_size,
  }
}

// ── Legacy pro API types (api.autodl.com, developer token) ──

export interface InstanceListData {
  list: InstanceSummaryRaw[]
  page_index: number
  page_size: number
  max_page: number
  result_total: number
}

export interface InstanceSummaryRaw {
  uuid: string
  name: string
  machine_id: string
  machine_alias: string
  region_sign: string
  region_name: string
  gpu_spec_uuid: string
  req_gpu_amount: number
  status: string
  sub_status: string
  status_at: string
  start_mode: string
  charge_type: string
  created_at: string
  started_at: NullableTime
  stopped_at: NullableTime
  expired_at: NullableTime
  timed_shutdown_at: NullableTime
}

export function formatProSummary(raw: InstanceSummaryRaw): InstanceSummary {
  return {
    uuid: raw.uuid,
    name: raw.name,
    machineId: raw.machine_id,
    machineAlias: raw.machine_alias,
    regionSign: raw.region_sign,
    regionName: raw.region_name,
    gpuSpecUuid: raw.gpu_spec_uuid,
    requestedGpuAmount: raw.req_gpu_amount,
    status: raw.status,
    subStatus: raw.sub_status,
    statusAt: raw.status_at,
    startMode: raw.start_mode,
    chargeType: raw.charge_type,
    createdAt: raw.created_at,
    startedAt: formatTime(raw.started_at),
    stoppedAt: formatTime(raw.stopped_at),
    expiredAt: formatTime(raw.expired_at),
    timedShutdownAt: formatTime(raw.timed_shutdown_at),
    paygPrice: 0,
  }
}

// ── Snapshot (pro API only; web API returns this inline) ──

export interface InstanceSnapshotRaw {
  region_sign: string
  ssh_command: string
  proxy_host: string
  ssh_port: number
  root_password: string
  jupyter_token: string
  jupyter_domain: string
  snapshot_gpu_alias_name: string
  chip_corp: string
  cpu_arch: string
  usage_info: {
    cpu_usage_percent: number
    mem_usage_percent: number
    root_fs_used_size: number
    root_fs_total_size: number
  }
}

export function formatInstanceSnapshot(uuid: string, raw: InstanceSnapshotRaw): InstanceSnapshot {
  return {
    uuid,
    regionSign: raw.region_sign,
    sshCommand: raw.ssh_command,
    proxyHost: raw.proxy_host,
    sshPort: raw.ssh_port,
    rootPassword: raw.root_password,
    jupyterToken: raw.jupyter_token,
    jupyterDomain: raw.jupyter_domain,
    gpuAliasName: raw.snapshot_gpu_alias_name,
    cpuUsagePercent: raw.usage_info.cpu_usage_percent,
    memUsagePercent: raw.usage_info.mem_usage_percent,
    rootFsUsedSize: raw.usage_info.root_fs_used_size,
    rootFsTotalSize: raw.usage_info.root_fs_total_size,
  }
}

// ── Balance ──

// GET /api/v1/wallet/balance?charge_type=payg (web API)
// Amounts in 1/1000 yuan
export interface BalanceData {
  assets: number
  voucher_balance: number
  accumulate: number
}

// ── Other ──

export type InstanceStatusData = string
export type PowerOnData = null
export type PowerOffData = null
