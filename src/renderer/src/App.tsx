import { useState, useEffect, useCallback, useRef } from 'react'
import './App.css'
import { TerminalPanel } from './TerminalPanel'

type Page = 'loading' | 'setup' | 'dashboard'
type PowerAction = 'power-on' | 'power-off'
type PowerOperation = { uuid: string; action: PowerAction }
type OperationMessage = { kind: 'success' | 'error'; text: string }
type LoadDashboardOptions = { keepOperationMessage?: boolean }
type JupyterAccess = {
  canOpen: boolean
  displayUrl: string | null
  openUrl: string | null
  monitorUrl: string | null
  hasToken: boolean
  reason: string | null
  warning: string | null
}

const RESOURCE_REFRESH_INTERVAL_MS = 3000
const MONITOR_INTERVAL_OPTIONS = [15, 30, 60, 120, 300]

function App(): JSX.Element {
  const [page, setPage] = useState<Page>('loading')
  const [error, setError] = useState<string | null>(null)
  const [balance, setBalance] = useState<BalanceData | null>(null)
  const [instances, setInstances] = useState<InstanceSummary[]>([])
  const [busy, setBusy] = useState(false)
  const [selectedUuid, setSelectedUuid] = useState<string | null>(null)
  const [snapshot, setSnapshot] = useState<InstanceSnapshot | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [showPassword, setShowPassword] = useState(false)
  const [showJupyterToken, setShowJupyterToken] = useState(false)
  const [copyLabel, setCopyLabel] = useState<string | null>(null)
  const [detailRefreshKey, setDetailRefreshKey] = useState(0)
  const [powerOperation, setPowerOperation] = useState<PowerOperation | null>(null)
  const [operationMessage, setOperationMessage] = useState<OperationMessage | null>(null)
  const [monitorState, setMonitorState] = useState<MonitorState | null>(null)
  const [monitorBusy, setMonitorBusy] = useState(false)
  const [monitorMessage, setMonitorMessage] = useState<OperationMessage | null>(null)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    window.electronAPI.hasToken().then((has) => {
      if (has) {
        setPage('dashboard')
        loadDashboard()
        loadMonitorState()
      } else {
        setPage('setup')
      }
    })
  }, [])

  useEffect(() => {
    return window.electronAPI.onMonitorEvent((event) => {
      setMonitorState(event.state)

      if (event.type === 'poll-success') {
        setInstances(event.instances)
        return
      }

      if (event.type === 'poll-error') {
        setMonitorMessage({
          kind: 'error',
          text: `监控轮询失败：${event.error}`,
        })
        return
      }

      if (event.type === 'status-change') {
        setMonitorMessage({
          kind: 'success',
          text: `${event.change.name} 状态变化：${formatMonitorChange(event.change)}`,
        })
        return
      }

      setMonitorMessage({
        kind: 'success',
        text: `${event.instanceName} 有卡开机成功。`,
      })
    })
  }, [])

  useEffect(() => {
    if (!selectedUuid) {
      setSnapshot(null)
      setDetailError(null)
      setDetailLoading(false)
      return
    }
    let cancelled = false
    let inFlight = false
    let intervalId: ReturnType<typeof setInterval> | null = null

    const loadSnapshot = async (showLoading: boolean): Promise<void> => {
      if (inFlight) return
      inFlight = true
      if (showLoading) {
        setDetailLoading(true)
      }
      setDetailError(null)
      try {
        const res = await window.electronAPI.getInstanceSnapshot(selectedUuid)
        if (cancelled) return
        if (res.success) {
          setSnapshot(res.data)
        } else {
          setDetailError(res.error)
          if (showLoading) setSnapshot(null)
        }
      } catch (err) {
        if (cancelled) return
        setDetailError(err instanceof Error ? err.message : '加载资源数据失败')
        if (showLoading) setSnapshot(null)
      } finally {
        inFlight = false
        if (!cancelled && showLoading) {
          setDetailLoading(false)
        }
      }
    }

    setShowPassword(false)
    setShowJupyterToken(false)
    setDetailLoading(true)
    setDetailError(null)
    loadSnapshot(true)
    intervalId = setInterval(() => {
      loadSnapshot(false)
    }, RESOURCE_REFRESH_INTERVAL_MS)

    return () => {
      cancelled = true
      if (intervalId) clearInterval(intervalId)
    }
  }, [selectedUuid, detailRefreshKey])

  const loadDashboard = useCallback(async (options: LoadDashboardOptions = {}) => {
    setBusy(true)
    setError(null)
    if (!options.keepOperationMessage) setOperationMessage(null)

    const [balanceRes, instancesRes] = await Promise.all([
      window.electronAPI.getBalance(),
      window.electronAPI.listInstances(),
    ])

    setBusy(false)

    if (balanceRes.success) {
      setBalance(balanceRes.data)
    } else {
      setError(balanceRes.error)
      if (balanceRes.error.includes('Token')) {
        setPage('setup')
        return
      }
    }

    if (instancesRes.success) {
      setInstances(instancesRes.data)
    } else {
      setError((prev) => (prev ? prev + ' | ' : '') + instancesRes.error)
    }
  }, [])

  const loadMonitorState = useCallback(async () => {
    const res = await window.electronAPI.getMonitorState()
    if (res.success) {
      setMonitorState(res.data)
    } else {
      setMonitorMessage({ kind: 'error', text: res.error })
    }
  }, [])

  const handleBrowserLogin = async () => {
    setError(null)
    setOperationMessage(null)
    setBusy(true)
    const res = await window.electronAPI.loginViaBrowser()
    setBusy(false)
    if (res.success) {
      setPage('dashboard')
      await loadDashboard()
      await loadMonitorState()
    } else {
      setError(res.error)
    }
  }

  const handleClearToken = async () => {
    await window.electronAPI.clearToken()
    setPage('setup')
    setBalance(null)
    setInstances([])
    setSelectedUuid(null)
    setSnapshot(null)
    setError(null)
    setOperationMessage(null)
    setMonitorState(null)
    setMonitorMessage(null)
  }

  const handleSelectInstance = (uuid: string) => {
    setSelectedUuid((prev) => (prev === uuid ? null : uuid))
  }

  const handlePowerAction = async (instance: InstanceSummary, action: PowerAction) => {
    if (powerOperation) return

    const actionLabel = action === 'power-on' ? '有卡开机' : '关机'
    setPowerOperation({ uuid: instance.uuid, action })
    setOperationMessage(null)
    setError(null)

    try {
      const res =
        action === 'power-on'
          ? await window.electronAPI.powerOn(instance.uuid, instance.name)
          : await window.electronAPI.powerOff(instance.uuid)

      if (!res.success) {
        setOperationMessage({
          kind: 'error',
          text: `${instance.name} ${actionLabel}失败：${res.error}`,
        })
        return
      }

      setOperationMessage({
        kind: 'success',
        text: `${instance.name} ${actionLabel}请求已提交，状态已刷新。`,
      })
      await loadDashboard({ keepOperationMessage: true })
      if (selectedUuid === instance.uuid) {
        setDetailRefreshKey((key) => key + 1)
      }
    } catch (err) {
      setOperationMessage({
        kind: 'error',
        text: `${instance.name} ${actionLabel}失败：${
          err instanceof Error ? err.message : '未知错误'
        }`,
      })
    } finally {
      setPowerOperation(null)
    }
  }

  const handleCopy = (text: string, label: string) => {
    navigator.clipboard.writeText(text)
    setCopyLabel(label)
    if (copyTimer.current) clearTimeout(copyTimer.current)
    copyTimer.current = setTimeout(() => setCopyLabel(null), 2000)
  }

  const handleOpenJupyter = async () => {
    const selectedInstanceForOpen = selectedUuid
      ? instances.find((instance) => instance.uuid === selectedUuid) ?? null
      : null
    const access = getJupyterAccess(selectedInstanceForOpen, snapshot)
    if (!access.openUrl) {
      setDetailError(access.reason || '当前实例没有可打开的 JupyterLab 地址')
      return
    }

    try {
      const opened = await window.electronAPI.openExternal(access.openUrl)
      if (!opened) {
        setDetailError('JupyterLab 地址格式无效，未打开浏览器')
      }
    } catch (err) {
      setDetailError(`打开 JupyterLab 失败：${err instanceof Error ? err.message : '未知错误'}`)
    }
  }

  const handleToggleMonitor = async () => {
    setMonitorBusy(true)
    setMonitorMessage(null)
    const res = monitorState?.running
      ? await window.electronAPI.stopMonitor()
      : await window.electronAPI.startMonitor()
    setMonitorBusy(false)
    if (res.success) {
      setMonitorState(res.data)
    } else {
      setMonitorMessage({ kind: 'error', text: res.error })
    }
  }

  const handlePollMonitorNow = async () => {
    setMonitorBusy(true)
    setMonitorMessage(null)
    const res = await window.electronAPI.pollMonitorNow()
    setMonitorBusy(false)
    if (res.success) {
      setMonitorState(res.data)
    } else {
      setMonitorMessage({ kind: 'error', text: res.error })
    }
  }

  const handleMonitorSettingsChange = async (settings: Partial<MonitorSettings>) => {
    setMonitorBusy(true)
    setMonitorMessage(null)
    const res = await window.electronAPI.updateMonitorSettings(settings)
    setMonitorBusy(false)
    if (res.success) {
      setMonitorState(res.data)
    } else {
      setMonitorMessage({ kind: 'error', text: res.error })
    }
  }

  const renderPowerButtons = (
    instance: InstanceSummary,
    variant: 'table' | 'detail' = 'table',
  ): JSX.Element => {
    const pendingAction =
      powerOperation?.uuid === instance.uuid ? powerOperation.action : null
    const anyOperationRunning = powerOperation !== null
    const powerOnDisabled =
      anyOperationRunning || !canPowerOn(instance)
    const powerOffDisabled =
      anyOperationRunning || !canPowerOff(instance)

    return (
      <div className={variant === 'detail' ? 'detail-actions' : 'inline-actions'}>
        <button
          className="btn btn-sm btn-start"
          disabled={powerOnDisabled}
          onClick={(event) => {
            event.stopPropagation()
            handlePowerAction(instance, 'power-on')
          }}
          title={canPowerOn(instance) ? '有卡模式开机' : '当前状态不可开机'}
        >
          {pendingAction === 'power-on' ? '开机中...' : '有卡开机'}
        </button>
        <button
          className="btn btn-sm btn-danger"
          disabled={powerOffDisabled}
          onClick={(event) => {
            event.stopPropagation()
            handlePowerAction(instance, 'power-off')
          }}
          title={canPowerOff(instance) ? '关闭运行中的实例' : '当前状态不可关机'}
        >
          {pendingAction === 'power-off' ? '关机中...' : '关机'}
        </button>
      </div>
    )
  }

  const formatBytes = (bytes: number): string => {
    if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    return `${(bytes / 1024).toFixed(1)} KB`
  }

  const formatYuan = (amount1000: number): string => {
    return (amount1000 / 1000).toFixed(2)
  }

  // ── Loading ──
  if (page === 'loading') {
    return (
      <div className="app">
        <main className="app-main center">
          <p className="loading-text">加载中...</p>
        </main>
      </div>
    )
  }

  // ── Setup ──
  if (page === 'setup') {
    return (
      <div className="app">
        <header className="app-header">
          <h1>AutoDL Watcher</h1>
          <p className="app-subtitle">AutoDL 实例监控与控制工具</p>
        </header>
        <main className="app-main">
          <div className="card setup-card">
            <h2>登录 AutoDL</h2>
            <p className="setup-hint">
              点击下方按钮，在弹出窗口中登录你的 AutoDL 账号。登录凭证将自动获取并加密保存。
            </p>
            <button
              className="btn btn-secondary"
              onClick={handleBrowserLogin}
              disabled={busy}
            >
              {busy ? '等待登录完成...' : '打开 AutoDL 登录'}
            </button>
            {error && <div className="error-msg">{error}</div>}
          </div>
        </main>
        <footer className="app-footer">
          <span>v0.1.0</span>
        </footer>
      </div>
    )
  }

  const selectedInstance = selectedUuid
    ? instances.find((instance) => instance.uuid === selectedUuid) ?? null
    : null
  const currentMonitorSettings = monitorState?.settings ?? {
    pollIntervalSeconds: 60,
    notifyOnStatusChange: true,
    notifyOnPowerOnSuccess: true,
  }
  const monitorIntervalOptions = MONITOR_INTERVAL_OPTIONS.includes(
    currentMonitorSettings.pollIntervalSeconds,
  )
    ? MONITOR_INTERVAL_OPTIONS
    : [...MONITOR_INTERVAL_OPTIONS, currentMonitorSettings.pollIntervalSeconds].sort(
        (a, b) => a - b,
      )
  const jupyterAccess = getJupyterAccess(selectedInstance, snapshot)

  // ── Dashboard ──
  return (
    <div className="app">
      <header className="app-header">
        <h1>AutoDL Watcher</h1>
        <div className="header-actions">
          <button className="btn btn-sm" onClick={() => loadDashboard()} disabled={busy}>
            {busy ? '刷新中...' : '刷新'}
          </button>
          <button className="btn btn-sm btn-danger" onClick={handleClearToken}>
            清除 Token
          </button>
        </div>
      </header>
      <main className="app-main">
        {error && <div className="error-msg">{error}</div>}
        {operationMessage && (
          <div className={operationMessage.kind === 'success' ? 'success-msg' : 'error-msg'}>
            {operationMessage.text}
          </div>
        )}
        {monitorMessage && (
          <div className={monitorMessage.kind === 'success' ? 'success-msg' : 'error-msg'}>
            {monitorMessage.text}
          </div>
        )}

        {/* Balance */}
        <div className="card balance-row">
          {balance ? (
            <>
              <div className="balance-item">
                <span className="balance-label">余额</span>
                <span className="balance-amount">¥ {formatYuan(balance.assets)}</span>
              </div>
              <div className="balance-item">
                <span className="balance-label">代金券</span>
                <span className="balance-amount">¥ {formatYuan(balance.voucher_balance)}</span>
              </div>
              <div className="balance-item">
                <span className="balance-label">累计消费</span>
                <span className="balance-amount secondary">¥ {formatYuan(balance.accumulate)}</span>
              </div>
            </>
          ) : (
            <div className="balance-item">
              <span className="balance-label">余额</span>
              <span className="balance-amount">—</span>
            </div>
          )}
        </div>

        {/* Monitor */}
        <div className="card monitor-card">
          <div className="monitor-header">
            <div>
              <h3>监控与通知</h3>
              <div className="monitor-meta">
                <span
                  className={`monitor-dot ${monitorState?.running ? 'running' : 'stopped'}`}
                />
                <span>{monitorState?.running ? '监控中' : '未启动'}</span>
                <span>上次轮询：{formatMonitorTime(monitorState?.lastPollAt)}</span>
                <span>通知：{monitorState?.notificationSupported === false ? '不可用' : '可用'}</span>
              </div>
            </div>
            <div className="monitor-actions">
              <button
                className="btn btn-sm btn-secondary"
                onClick={handleToggleMonitor}
                disabled={monitorBusy || monitorState?.polling}
              >
                {monitorState?.running ? '停止监控' : '开始监控'}
              </button>
              <button
                className="btn btn-sm"
                onClick={handlePollMonitorNow}
                disabled={monitorBusy || monitorState?.polling}
              >
                {monitorState?.polling ? '轮询中...' : '立即轮询'}
              </button>
            </div>
          </div>

          <div className="monitor-controls">
            <label className="monitor-field">
              <span>轮询间隔</span>
              <select
                className="select-input"
                value={currentMonitorSettings.pollIntervalSeconds}
                disabled={monitorBusy}
                onChange={(event) =>
                  handleMonitorSettingsChange({
                    pollIntervalSeconds: Number(event.target.value),
                  })
                }
              >
                {monitorIntervalOptions.map((seconds) => (
                  <option key={seconds} value={seconds}>
                    {formatInterval(seconds)}
                  </option>
                ))}
              </select>
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={currentMonitorSettings.notifyOnStatusChange}
                disabled={monitorBusy}
                onChange={(event) =>
                  handleMonitorSettingsChange({
                    notifyOnStatusChange: event.target.checked,
                  })
                }
              />
              <span>状态变化通知</span>
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={currentMonitorSettings.notifyOnPowerOnSuccess}
                disabled={monitorBusy}
                onChange={(event) =>
                  handleMonitorSettingsChange({
                    notifyOnPowerOnSuccess: event.target.checked,
                  })
                }
              />
              <span>开机成功通知</span>
            </label>
          </div>
          {monitorState?.lastError && (
            <div className="monitor-error">最近错误：{monitorState.lastError}</div>
          )}
        </div>

        {/* Instances */}
        <div className="card instances-card">
          <h3>实例列表 ({instances.length})</h3>
          {instances.length === 0 && !busy && (
            <p className="empty-hint">暂无实例</p>
          )}
          {busy && instances.length === 0 && (
            <p className="empty-hint">加载中...</p>
          )}
          {instances.length > 0 && (
            <div className="table-scroll">
              <table className="instance-table">
                <thead>
                  <tr>
                    <th>名称</th>
                    <th>地区</th>
                    <th>GPU 规格</th>
                    <th>GPU 数量</th>
                    <th>状态</th>
                    <th>计费方式</th>
                    <th>启动时间</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {instances.map((inst) => (
                    <tr
                      key={inst.uuid}
                      className={selectedUuid === inst.uuid ? 'row-selected' : ''}
                      onClick={() => handleSelectInstance(inst.uuid)}
                    >
                      <td title={inst.uuid}>{inst.name}</td>
                      <td title={inst.regionSign}>{inst.regionName}</td>
                      <td>{inst.gpuSpecUuid}</td>
                      <td>{inst.requestedGpuAmount}</td>
                      <td>
                        <span className={`status-tag status-${inst.status}`}>
                          {inst.status}
                        </span>
                      </td>
                      <td>{inst.chargeType || '—'}</td>
                      <td className="time-cell">{inst.startedAt || '—'}</td>
                      <td className="actions-cell">{renderPowerButtons(inst)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Instance Detail Panel */}
        {selectedUuid && (
          <div className="card detail-panel">
            <div className="detail-header">
              <h3>
                实例详情
                {selectedInstance && <> — {selectedInstance.name}</>}
              </h3>
              <button className="btn btn-sm" onClick={() => setSelectedUuid(null)}>
                关闭
              </button>
            </div>

            {selectedInstance && (
              <section className="detail-section">
                <h4>实例操作</h4>
                {renderPowerButtons(selectedInstance, 'detail')}
              </section>
            )}

            {detailLoading && <p className="empty-hint">加载详情中...</p>}

            {detailError && <div className="error-msg">{detailError}</div>}

            {snapshot && !detailLoading && (
              <>
                {/* Basic Info */}
                <section className="detail-section">
                  <h4>基本信息</h4>
                  <div className="detail-grid">
                    <div className="detail-item">
                      <span className="detail-label">GPU</span>
                      <span className="detail-value">{snapshot.gpuAliasName || '—'}</span>
                    </div>
                    <div className="detail-item detail-full">
                      <span className="detail-label">UUID</span>
                      <span className="detail-value mono">{snapshot.uuid}</span>
                    </div>
                  </div>
                </section>

                {/* Resource Usage */}
                <ResourceUsageSection snapshot={snapshot} formatBytes={formatBytes} />

                {/* JupyterLab */}
                <section className="detail-section">
                  <h4>JupyterLab</h4>
                  {jupyterAccess.displayUrl ? (
                    <div className="detail-grid">
                      <div className="detail-item detail-full">
                        <span className="detail-label">地址</span>
                        <span className="detail-value mono">
                          {jupyterAccess.displayUrl}
                          <button
                            className="btn-copy"
                            onClick={() =>
                              handleCopy(jupyterAccess.displayUrl || '', 'Jupyter 地址')
                            }
                            title="复制地址"
                          >
                            {copyLabel === 'Jupyter 地址' ? '已复制' : '复制'}
                          </button>
                        </span>
                      </div>
                      <div className="detail-item detail-full">
                        <span className="detail-label">Token</span>
                        <span className="detail-value mono">
                          {jupyterAccess.hasToken ? (
                            <>
                              {showJupyterToken ? snapshot.jupyterToken : '•'.repeat(24)}
                              <button
                                className="btn-copy"
                                onClick={() => setShowJupyterToken(!showJupyterToken)}
                                title={showJupyterToken ? '隐藏' : '显示'}
                              >
                                {showJupyterToken ? '隐藏' : '显示'}
                              </button>
                              <button
                                className="btn-copy"
                                onClick={() => handleCopy(snapshot.jupyterToken, 'Jupyter Token')}
                                title="复制 Token"
                              >
                                {copyLabel === 'Jupyter Token' ? '已复制' : '复制'}
                              </button>
                            </>
                          ) : (
                            <span className="muted-text">未返回</span>
                          )}
                        </span>
                      </div>
                      <div className="detail-item detail-full jupyter-action-row">
                        <button
                          className="btn btn-primary btn-inline"
                          disabled={!jupyterAccess.canOpen}
                          onClick={handleOpenJupyter}
                          title={
                            jupyterAccess.canOpen
                              ? '在默认浏览器中打开 JupyterLab'
                              : jupyterAccess.reason || '当前不可打开'
                          }
                        >
                          打开 JupyterLab
                        </button>
                        {jupyterAccess.warning && (
                          <span className="jupyter-note">{jupyterAccess.warning}</span>
                        )}
                      </div>
                      <div className="detail-item detail-full">
                        <span className="detail-label">打开地址</span>
                        <span className="detail-value mono">
                          {jupyterAccess.openUrl || '—'}
                          {jupyterAccess.openUrl && (
                            <button
                              className="btn-copy"
                              onClick={() => handleCopy(jupyterAccess.openUrl || '', 'Jupyter 打开地址')}
                              title="复制打开地址"
                            >
                              {copyLabel === 'Jupyter 打开地址' ? '已复制' : '复制'}
                            </button>
                          )}
                        </span>
                      </div>
                      {jupyterAccess.monitorUrl && (
                        <div className="detail-item detail-full">
                          <span className="detail-label">AutoPanel 监控</span>
                          <span className="detail-value mono">
                            {jupyterAccess.monitorUrl}
                            <button
                              className="btn-copy"
                              onClick={() =>
                                handleCopy(jupyterAccess.monitorUrl || '', 'AutoPanel 监控地址')
                              }
                              title="复制监控地址"
                            >
                              {copyLabel === 'AutoPanel 监控地址' ? '已复制' : '复制'}
                            </button>
                          </span>
                        </div>
                      )}
                      {!jupyterAccess.canOpen && jupyterAccess.reason && (
                        <div className="detail-item detail-full">
                          <p className="empty-hint jupyter-reason">{jupyterAccess.reason}</p>
                        </div>
                      )}
                      {jupyterAccess.canOpen && (
                        <div className="detail-item detail-full">
                          <p className="empty-hint jupyter-reason">
                            如果 /lab?token=... 页面打开后空白，可手动把路径改为 /jupyter?token=...；当前按钮会直接打开 /jupyter?token=...。根路径会进入 AutoPanel 监控页，不是 JupyterLab。
                          </p>
                        </div>
                      )}
                    </div>
                  ) : (
                    <p className="empty-hint jupyter-reason">
                      {jupyterAccess.reason || 'AutoDL 未返回 JupyterLab 地址'}
                    </p>
                  )}
                </section>

                {/* SSH */}
                <section className="detail-section">
                  <h4>SSH 连接</h4>
                  <div className="detail-grid">
                    <div className="detail-item detail-full">
                      <span className="detail-label">命令</span>
                      <span className="detail-value mono">
                        {snapshot.sshCommand || `${snapshot.proxyHost} -p ${snapshot.sshPort}`}
                        <button
                          className="btn-copy"
                          onClick={() => handleCopy(snapshot.sshCommand || `ssh -p ${snapshot.sshPort} root@${snapshot.proxyHost}`, 'SSH 命令')}
                          title="复制命令"
                        >
                          {copyLabel === 'SSH 命令' ? '已复制' : '复制'}
                        </button>
                      </span>
                    </div>
                    <div className="detail-item">
                      <span className="detail-label">主机</span>
                      <span className="detail-value mono">{snapshot.proxyHost || '—'}</span>
                    </div>
                    <div className="detail-item">
                      <span className="detail-label">端口</span>
                      <span className="detail-value mono">{snapshot.sshPort || '—'}</span>
                    </div>
                    <div className="detail-item detail-full">
                      <span className="detail-label">密码</span>
                      <span className="detail-value mono">
                        {showPassword ? snapshot.rootPassword : '•'.repeat(16)}
                        <button
                          className="btn-copy"
                          onClick={() => setShowPassword(!showPassword)}
                          title={showPassword ? '隐藏' : '显示'}
                        >
                          {showPassword ? '隐藏' : '显示'}
                        </button>
                        <button
                          className="btn-copy"
                          onClick={() => handleCopy(snapshot.rootPassword, 'SSH 密码')}
                          title="复制密码"
                        >
                          {copyLabel === 'SSH 密码' ? '已复制' : '复制'}
                        </button>
                      </span>
                    </div>
                  </div>
                </section>

                {selectedInstance && (
                  <TerminalPanel
                    instance={selectedInstance}
                    snapshot={snapshot}
                    canConnect={isRunning(selectedInstance)}
                  />
                )}
              </>
            )}
          </div>
        )}
      </main>
      <footer className="app-footer">
        <span>v0.1.0</span>
      </footer>
    </div>
  )
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(value, 100))
}

function formatPercent(value: number): string {
  return `${Math.round(clampPercent(value))}%`
}

function getInstanceStateText(instance: InstanceSummary): string {
  return `${instance.status || ''} ${instance.subStatus || ''}`.trim().toLowerCase()
}

function isTransitioning(instance: InstanceSummary): boolean {
  const state = getInstanceStateText(instance)
  return (
    ['starting', 'stopping', 'restarting', 'pending', 'booting'].some((status) =>
      state.includes(status),
    ) || /启动中|关机中|重启中|创建中|排队中/.test(state)
  )
}

function isRunning(instance: InstanceSummary): boolean {
  const status = (instance.status || '').trim().toLowerCase()
  const state = getInstanceStateText(instance)
  return ['running', 'started'].includes(status) || state.includes('运行中') || status.includes('运行')
}

function canPowerOn(instance: InstanceSummary): boolean {
  return !isRunning(instance) && !isTransitioning(instance)
}

function canPowerOff(instance: InstanceSummary): boolean {
  return isRunning(instance) && !isTransitioning(instance)
}

function getJupyterAccess(
  instance: InstanceSummary | null,
  snapshot: InstanceSnapshot | null,
): JupyterAccess {
  const rawDomain = snapshot?.jupyterDomain?.trim() ?? ''
  const rawToken = snapshot?.jupyterToken?.trim() ?? ''
  const displayUrl = rawDomain ? normalizeJupyterUrl(rawDomain) : null
  const hasToken = rawToken.length > 0

  if (!snapshot) {
    return {
      canOpen: false,
      displayUrl,
      openUrl: null,
      monitorUrl: null,
      hasToken,
      reason: '实例详情加载完成后才能打开 JupyterLab',
      warning: null,
    }
  }

  if (!instance) {
    return {
      canOpen: false,
      displayUrl,
      openUrl: null,
      monitorUrl: null,
      hasToken,
      reason: '未找到实例状态，请刷新实例列表后重试',
      warning: null,
    }
  }

  if (!isRunning(instance)) {
    return {
      canOpen: false,
      displayUrl,
      openUrl: null,
      monitorUrl: null,
      hasToken,
      reason: `实例当前状态为 ${formatMonitorStatus(instance.status, instance.subStatus)}，运行中后才能打开 JupyterLab`,
      warning: null,
    }
  }

  if (!displayUrl) {
    return {
      canOpen: false,
      displayUrl: null,
      openUrl: null,
      monitorUrl: null,
      hasToken,
      reason: 'AutoDL 未返回 JupyterLab 地址，可能是实例刚启动尚未初始化完成，或当前镜像未启用 JupyterLab',
      warning: null,
    }
  }

  const openUrl = buildJupyterLabUrl(displayUrl, rawToken)
  const monitorUrl = buildAutoPanelMonitorUrl(displayUrl)
  if (!openUrl) {
    return {
      canOpen: false,
      displayUrl,
      openUrl: null,
      monitorUrl,
      hasToken,
      reason: 'JupyterLab 地址格式无效，无法打开',
      warning: null,
    }
  }

  return {
    canOpen: true,
    displayUrl,
    openUrl,
    monitorUrl,
    hasToken,
    reason: null,
    warning: hasToken ? null : '未返回 Jupyter Token，打开后可能需要在页面手动输入 Token',
  }
}

function normalizeJupyterUrl(domainOrUrl: string): string | null {
  const trimmed = domainOrUrl.trim().replace(/\/+$/, '')
  if (!trimmed) return null
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
}

function buildJupyterLabUrl(displayUrl: string, token: string): string | null {
  try {
    const url = new URL(displayUrl)
    url.pathname = '/jupyter'
    if (token.trim()) {
      url.searchParams.set('token', token.trim())
    }
    return url.toString()
  } catch {
    return null
  }
}

function buildAutoPanelMonitorUrl(displayUrl: string): string | null {
  try {
    const url = new URL(displayUrl)
    url.pathname = '/monitor'
    url.search = ''
    return url.toString()
  } catch {
    return null
  }
}

function formatInterval(seconds: number): string {
  if (seconds < 60) return `${seconds} 秒`
  if (seconds % 60 === 0) return `${seconds / 60} 分钟`
  return `${seconds} 秒`
}

function formatMonitorTime(value: string | null | undefined): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
}

function formatMonitorStatus(status: string, subStatus: string): string {
  const parts = [status, subStatus].filter((part) => part && part.trim())
  return parts.length > 0 ? parts.join(' / ') : '未知'
}

function formatMonitorChange(change: MonitorStatusChange): string {
  return `${formatMonitorStatus(change.previousStatus, change.previousSubStatus)} -> ${formatMonitorStatus(
    change.currentStatus,
    change.currentSubStatus,
  )}`
}

function ResourceUsageSection({
  snapshot,
  formatBytes,
}: {
  snapshot: InstanceSnapshot
  formatBytes: (bytes: number) => string
}): JSX.Element | null {
  const gpuMetrics = snapshot.gpuMetrics ?? []
  const hasUsage =
    snapshot.cpuUsagePercent > 0 ||
    snapshot.memUsagePercent > 0 ||
    snapshot.rootFsTotalSize > 0 ||
    gpuMetrics.length > 0

  if (!hasUsage) return null

  const averageGpuUsage =
    gpuMetrics.length > 0
      ? gpuMetrics.reduce((sum, gpu) => sum + gpu.utilizationPercent, 0) / gpuMetrics.length
      : 0
  const gpuMemoryMetrics = gpuMetrics.filter((gpu) => gpu.memoryUsagePercent != null)
  const hasGpuMemoryUsage = gpuMemoryMetrics.length > 0
  const averageGpuMemoryUsage = hasGpuMemoryUsage
    ? gpuMemoryMetrics.reduce((sum, gpu) => sum + (gpu.memoryUsagePercent ?? 0), 0) /
      gpuMemoryMetrics.length
    : 0
  const formatGpuMemory = (memoryUsedMB: number): string =>
    memoryUsedMB > 0 ? formatBytes(memoryUsedMB * 1024 * 1024) : '0 MB'
  const formatGpuMemoryTotal = (memoryTotalMB?: number): string | null =>
    memoryTotalMB && memoryTotalMB > 0 ? formatBytes(memoryTotalMB * 1024 * 1024) : null
  const gpuBreakdown = gpuMetrics
    .map((gpu) => {
      const memoryTotal = formatGpuMemoryTotal(gpu.memoryTotalMB)
      const memoryPercent =
        gpu.memoryUsagePercent != null ? `${formatPercent(gpu.memoryUsagePercent)} ` : ''
      const memoryText = memoryTotal
        ? `${memoryPercent}${formatGpuMemory(gpu.memoryUsedMB)} / ${memoryTotal}`
        : formatGpuMemory(gpu.memoryUsedMB)

      return `GPU ${gpu.index}: GPU ${formatPercent(gpu.utilizationPercent)}, 显存 ${memoryText}`
    })
    .join(' / ')

  return (
    <section className="detail-section">
      <h4>资源使用</h4>
      <div className="resource-bars">
        {gpuMetrics.length > 0 && (
          <>
            <div className="resource-row" title={gpuBreakdown}>
              <span className="resource-label">GPU</span>
              <div className="resource-bar-track">
                <div
                  className="resource-bar-fill gpu"
                  style={{ width: `${clampPercent(averageGpuUsage)}%` }}
                />
              </div>
              <span className="resource-pct">{formatPercent(averageGpuUsage)}</span>
            </div>
            <div className="resource-row" title={gpuBreakdown}>
              <span className="resource-label">显存</span>
              <div className="resource-bar-track">
                <div
                  className="resource-bar-fill vram"
                  style={{
                    width: hasGpuMemoryUsage ? `${clampPercent(averageGpuMemoryUsage)}%` : '0%',
                  }}
                />
              </div>
              <span className="resource-pct">
                {hasGpuMemoryUsage ? formatPercent(averageGpuMemoryUsage) : 'N/A'}
              </span>
            </div>
          </>
        )}
        <div className="resource-row">
          <span className="resource-label">CPU</span>
          <div className="resource-bar-track">
            <div
              className="resource-bar-fill cpu"
              style={{ width: `${clampPercent(snapshot.cpuUsagePercent)}%` }}
            />
          </div>
          <span className="resource-pct">{formatPercent(snapshot.cpuUsagePercent)}</span>
        </div>
        <div className="resource-row">
          <span className="resource-label">内存</span>
          <div className="resource-bar-track">
            <div
              className="resource-bar-fill mem"
              style={{ width: `${clampPercent(snapshot.memUsagePercent)}%` }}
            />
          </div>
          <span className="resource-pct">{formatPercent(snapshot.memUsagePercent)}</span>
        </div>
        <div className="resource-row">
          <span className="resource-label">系统盘</span>
          <div className="resource-bar-track">
            <div
              className="resource-bar-fill disk"
              style={{
                width:
                  snapshot.rootFsTotalSize > 0
                    ? `${Math.min((snapshot.rootFsUsedSize / snapshot.rootFsTotalSize) * 100, 100)}%`
                    : '0%',
              }}
            />
          </div>
          <span className="resource-pct">
            {formatBytes(snapshot.rootFsUsedSize)} / {formatBytes(snapshot.rootFsTotalSize)}
          </span>
        </div>
      </div>
    </section>
  )
}

export default App
