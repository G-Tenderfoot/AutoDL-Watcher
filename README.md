# AutoDL Watcher

Windows 本地 AutoDL 实例监控与控制工具。

AutoDL Watcher 用 Electron + React + TypeScript 构建，面向经常使用 AutoDL 按量实例的个人工作流。它把登录凭证捕获、实例列表、状态轮询、开关机、JupyterLab 入口、SSH 终端和 SFTP 文件上传集中到一个桌面应用里，减少反复打开网页控制台查看 GPU 是否可用的操作。

> 非官方项目：本工具不是 AutoDL 官方客户端。它当前主要依赖 AutoDL 网页端接口和登录态，AutoDL 页面或接口变化可能导致部分功能需要适配。

## 功能特性

- 网页登录：通过内置登录窗口获取 AutoDL JWT + Cookie，不保存网页登录账号密码。
- 加密存储：使用 Electron `safeStorage` 将登录凭证保存到本机 `userData` 目录。
- 实例看板：展示余额、实例名称、地区、GPU 规格、状态、计费方式、启动/停止时间等信息。
- 实例详情：展示资源使用、JupyterLab、SSH 命令、端口、密码等运行信息，并支持复制敏感字段。
- 有卡开机/关机：支持对实例发起有卡模式开机和关机请求，操作后自动刷新状态。
- 监控通知：主进程定时轮询实例状态，状态变化或开机成功时发送 Windows 桌面通知。
- JupyterLab 入口：运行中实例可直接在默认浏览器打开 `/jupyter?token=...`。
- 内置终端：使用 `ssh2` 在主进程建立 SSH 会话，渲染进程通过 xterm.js 显示交互式终端。
- 文件上传：拖拽本地文件后，通过 SFTP 上传到指定远端绝对目录，默认目录为 `/root/autodl-tmp`。
- Windows 打包：支持生成 NSIS 安装包和 portable 便携版。

## 当前状态

版本：`0.1.0`

已完成核心 MVP：实例列表、详情、网页登录态保存、开关机、监控通知、JupyterLab 入口、内置 SSH 终端、SFTP 拖拽上传和 Windows 打包配置。

部分能力依赖真实运行中的 AutoDL 实例，例如 SSH 连接、基础命令执行和 SFTP 上传。首次使用建议先在低风险实例上验证，开机/关机会影响计费。

## 预览

应用主界面包含三个主要区域：

- 顶部状态栏：登录状态、余额、刷新和退出登录。
- 左侧/主区域：实例列表、实例状态、地区、GPU、计费信息和快捷操作。
- 详情区域：资源使用、JupyterLab、SSH 信息、内置终端和文件上传。

## 安装使用

### 从 Release 安装

如果仓库已经发布 Release，优先下载 Windows 构建产物：

- `AutoDL Watcher-0.1.0-x64.exe`：安装版。
- `AutoDL Watcher-0.1.0-portable-x64.exe`：便携版。

首次启动后点击“打开 AutoDL 登录”，在弹出的 AutoDL 页面完成登录，并停留在实例列表页，应用会自动捕获登录凭证。

### 从源码运行

环境要求：

- Windows 10/11
- Node.js 18+
- npm

```bash
npm install
npm run dev
```

国内网络如果下载 Electron 较慢，可以在 PowerShell 中设置镜像后安装：

```powershell
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
npm install
```

## 常用命令

```bash
npm run dev             # 启动开发环境并打开 Electron 窗口
npm run typecheck       # 同时检查主进程/预加载/渲染进程 TypeScript 类型
npm run build           # 生产构建，输出到 out/
npm run pack            # 构建后生成未安装的应用目录
npm run dist:win        # 构建 Windows 安装包和 portable 版
npm run preview         # 预览构建产物
```

构建产物默认输出到 `dist/`，源码构建输出到 `out/`。这两个目录已在 `.gitignore` 中忽略。

## 使用流程

1. 启动应用，点击“打开 AutoDL 登录”。
2. 在登录窗口中完成 AutoDL 网页登录，并停留在实例列表页。
3. 返回主窗口，查看余额和实例列表。
4. 点击实例行查看详情，包括资源使用、JupyterLab、SSH 信息。
5. 对未运行实例点击“有卡开机”，对运行中实例点击“关机”。
6. 在“监控与通知”中设置轮询间隔，启动状态监控。
7. 实例运行后可打开 JupyterLab，或连接内置终端。
8. 需要上传文件时，将文件拖入上传面板，确认远端目录后上传。

## 技术栈

- Electron 33：桌面窗口、主进程、系统通知、外部浏览器打开。
- React 18 + TypeScript：渲染进程 UI。
- Vite + electron-vite：多进程构建。
- axios：AutoDL 网页端 API / Pro API 请求。
- Electron `safeStorage`：本机加密保存 JWT + Cookie。
- `@xterm/xterm` + `@xterm/addon-fit`：内置终端 UI。
- `ssh2`：SSH 连接和 SFTP 上传。
- electron-builder：Windows 安装包和 portable 包。

## 项目结构

```text
src/
├── main/
│   ├── api/
│   │   ├── client.ts          # AutoDL API 客户端，网页端优先，Pro API 回退
│   │   └── types.ts           # API 数据类型和格式化逻辑
│   ├── services/
│   │   ├── auth-window.ts     # 内置网页登录窗口，捕获 JWT + Cookie
│   │   ├── monitor.ts         # 状态轮询和 Windows 通知
│   │   ├── ssh.ts             # SSH 终端和 SFTP 上传
│   │   └── token.ts           # safeStorage 凭证读写
│   ├── index.ts               # Electron 主进程入口
│   └── ipc.ts                 # IPC 处理器
├── preload/
│   └── index.ts               # contextBridge 暴露给渲染进程的 API
└── renderer/
    ├── index.html
    └── src/
        ├── App.tsx            # 主界面
        ├── TerminalPanel.tsx  # 终端和拖拽上传面板
        ├── App.css
        └── types/
            └── electron.d.ts
```

## API 与认证策略

当前主要使用 AutoDL 网页端接口：

```text
GET  https://www.autodl.com/api/v1/wallet/balance?charge_type=payg
POST https://www.autodl.com/api/v1/instance
POST https://www.autodl.com/api/v1/instance/power_on
POST https://www.autodl.com/api/v1/instance/power_off
```

网页登录窗口会通过两种方式捕获凭证：

- 主进程 `session.webRequest.onBeforeSendHeaders` 读取网页端 API 请求中的 `Authorization` 和 Cookie。
- 页面注入 `fetch` / `XMLHttpRequest` hook 作为兜底，读取请求中的 JWT。

如果网页端接口不可用，会回退尝试开发者 Pro API：

```text
POST /api/v1/dev/wallet/balance
POST /api/v1/dev/instance/pro/list
GET  /api/v1/dev/instance/pro/status
GET  /api/v1/dev/instance/pro/snapshot
POST /api/v1/dev/instance/pro/power_on
POST /api/v1/dev/instance/pro/power_off
```

注意：开发者 Pro API 只覆盖“容器实例 Pro”类型，可能不包含普通按量计费实例。

## 安全说明

- 不保存 AutoDL 网页账号密码。
- JWT + Cookie 使用 Electron `safeStorage` 加密保存。
- 清除登录凭证会关闭现有 SSH 会话并重置 API 客户端。
- 日志输出会过滤 `authorization`、`cookie`、`token`、`rootPassword`、`jupyterToken` 等敏感字段。
- 开机、关机属于可能产生费用或影响运行状态的操作，应用只通过明确按钮触发。
- 当前监控功能只做状态轮询和通知，不会自动开机。

## 已知限制

- 当前优先支持 Windows。
- AutoDL 网页端接口不是公开稳定 API，页面认证流程变化时可能需要更新适配。
- 没有独立的“查询 GPU 库存”接口；有卡开机是否成功以 AutoDL 接口返回结果为准。
- 暂不支持无卡模式开机、定时关机、多账号管理、释放实例、保存镜像、创建实例等高风险操作。
- 内置终端和 SFTP 上传依赖实例快照中的 SSH 主机、端口和 root 密码，实例未运行或详情尚未刷新时不可用。

## 排障

### 登录超时

确认已经在弹出的 AutoDL 登录窗口完成登录，并停留在 AutoDL 实例列表页。应用需要捕获实例列表请求里的 JWT 和 Cookie。

### 实例列表为空

先刷新登录态，再确认 AutoDL 网页控制台中能看到实例。如果只使用开发者 Pro API，普通按量计费实例可能不会出现在 `/dev/instance/pro/list` 中。

### JupyterLab 打开后空白

应用默认打开 `/jupyter?token=...`。如果手动访问 `/lab?token=...` 出现空白，可以改用 `/jupyter?token=...`。根路径通常进入 AutoPanel 监控页，不是 JupyterLab。

### SSH 连接失败

确认实例处于运行中，刷新实例详情后重试。若仍失败，检查 AutoDL 控制台返回的 SSH 主机、端口和 root 密码是否有效。

### 上传失败

远端目录必须是 Linux 绝对路径，例如 `/root/autodl-tmp`。当前只支持上传普通文件，不支持直接上传目录。

## 路线图

- 真实实例链路回归测试：SSH、`pwd` / `ls` / `nvidia-smi`、SFTP 上传确认。
- 托盘后台运行。
- 实例运行资源图表。
- 多实例关注列表。
- 操作历史和错误原因统计。
- 自动尝试有卡开机：需要显式开关、频率限制和计费风险提示。
- 定时关机设置。

## 参考资料

- [AutoDL API 文档](https://www.autodl.com/docs/common_api/)
- [AutoDL 容器实例 Pro API](https://www.autodl.com/docs/instance_pro_api/)
- [AutoDL JupyterLab 文档](https://www.autodl.com/docs/jupyterlab/)
- [AutoDL SSH 文档](https://www.autodl.com/docs/ssh/)
- [electron-vite](https://electron-vite.org/)
- [electron-builder](https://www.electron.build/)

## License

本仓库暂未声明开源许可证。公开发布并允许他人复用前，建议补充 `LICENSE` 文件。
