# Codex Switch

Codex Switch 是一个用于管理 Codex 桌面应用账号与供应商配置的桌面工具。

它可以把多套 Codex 登录信息和模型供应商配置保存为 Profile，并在需要时一键切换到指定 Profile。切换后，Codex Switch 会写入本机的 Codex 配置文件，并尝试重启正在运行的 Codex 桌面应用，让新配置立即生效。

## 适合谁使用

- 需要在多个 Codex 账号之间切换的用户
- 同时使用 Official OpenAI OAuth 和自定义 API 供应商的用户
- 需要临时切换模型供应商、base URL 或 API key 的用户
- 不希望反复手动编辑 `~/.codex/auth.json` 和 `~/.codex/config.toml` 的用户

## 它会管理哪些文件

Codex Switch 主要读写当前用户目录下的两个 Codex 配置文件：

```text
~/.codex/auth.json
~/.codex/config.toml
```

Profile 本身保存在 Codex Switch 的应用数据目录中，不会复用命令行工具的 profile 文件。

## 核心概念

### Profile

Profile 是一套可切换的 Codex 配置。每个 Profile 至少包含：

- Profile 名称
- Profile 类型
- 验证信息

如果是自定义供应商 Profile，还会包含：

- provider 名称
- provider 配置
- 可选的本地翻译代理设置

### Official OpenAI OAuth

适合使用 Codex 官方 OpenAI 登录态的场景。

切换到该类型 Profile 时，Codex Switch 会：

- 写入 `auth.json`
- 从 `config.toml` 顶层移除 `model_provider`
- 保留已有的 `model_providers` 配置表

### 自定义

适合使用第三方或自定义 OpenAI 兼容接口的场景。

切换到该类型 Profile 时，Codex Switch 会：

- 写入 `auth.json`
- 设置 `config.toml` 顶层 `model_provider`
- 写入对应的 `[model_providers.<name>]`

## 主要功能

- 新建、编辑、重命名、删除 Profile
- 从当前 `~/.codex` 配置导入 Profile
- 在 Official OpenAI OAuth 与自定义供应商之间切换
- 通过表单编辑 API key、token 和 provider 字段
- 支持直接编辑 `auth.json` 原文
- 支持直接编辑 Provider TOML 原文
- 敏感字段默认掩码显示，聚焦输入框时显示完整内容
- 切换 Profile 前弹窗确认
- 切换后关闭 Codex / extension-host 相关进程
- 尝试用当前正在运行的 Codex 桌面应用路径重新启动 Codex
- 支持开机启动、静默启动、关闭到托盘、主题设置
- 支持修复 Windows Computer Use 本地兼容插件与 bundled 插件缓存

## 基本使用流程

### 1. 导入当前配置

首次使用时，可以点击左侧的导入按钮，把当前 `~/.codex/auth.json` 和 `~/.codex/config.toml` 保存成一个 Profile。

建议先导入当前可用配置，作为回退 Profile。

### 2. 新建 Profile

点击左侧的新建按钮，填写 Profile 名称并选择类型：

- `Official OpenAI OAuth`
- `自定义`

如果选择 `自定义`，还需要填写供应商配置，例如：

- `model_provider`
- `name`
- `base_url`
- `wire_api`
- `requires_openai_auth`

### 3. 保存 Profile

编辑完成后，点击右下角保存按钮。保存 Profile 只会更新 Codex Switch 内部保存的数据，不会立即改写当前 Codex 配置。

### 4. 切换 Profile

选择目标 Profile 后，点击右下角切换按钮，或在左侧 Profile 列表中双击目标 Profile。

确认切换后，Codex Switch 会：

1. 将目标 Profile 写入 Codex 配置文件
2. 关闭 `codex.exe`、`extension-host.exe`、`extensionHost.exe`
3. 尝试重启当前正在运行的 Codex 桌面应用

如果没有找到 Codex 桌面应用路径，配置仍会完成切换，但需要手动重新打开 Codex。

## 官方账号验证模式

在设置中可以启用“OpenAI 官方账号验证”。

启用后，切换自定义 Profile 时不会覆盖 `auth.json`。Codex Switch 会保留所选 Official OpenAI OAuth Profile 的官方登录态，并把自定义 Profile 的 `OPENAI_API_KEY` 写入 provider 的 `experimental_bearer_token`。

这个模式适合需要保留官方 Codex 登录状态，同时让模型请求走自定义 provider 的场景。

## 本地翻译代理

自定义 Profile 可以启用本地翻译代理。启用后，切换到该 Profile 时，Codex Switch 会启动一个本地代理，并把 provider 的 `base_url` 改写为本机地址：

```text
http://127.0.0.1:<port>/v1
```

原始上游 `base_url` 仍保存在 Profile 中。切换到不使用代理的 Profile 时，代理会停止。

## Computer Use 本地兼容插件修复

设置页提供“修复 Computer Use 本地兼容插件”功能。

该操作会：

- 备份 `~/.codex/config.toml`
- 从已安装的 Codex Desktop 镜像 openai-bundled marketplace 到 `~/.codex/.tmp/bundled-marketplaces/openai-bundled`
- 写入本地 `computer-use@openai-bundled` 兼容插件
- 刷新 Browser、Chrome、Computer Use 的 bundled 插件缓存和 `latest` 指向
- 将 `config.toml` 指向本地 openai-bundled marketplace，并启用 `computer-use@openai-bundled`
- 设置用户环境变量 `CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE=1`
- 尽量修正 Chrome native messaging manifest 到稳定的 Chrome 缓存路径
- 自动重启当前运行的 Codex Desktop

如果没有找到正在运行的 Codex Desktop 可执行路径，Codex Switch 会提示手动重新打开 Codex。该功能不会重打包、签名或重装 Codex Desktop，因此不包含 Fast Mode / locale / browser gate 等 MSIX 补丁。

## 数据与安全

Codex Switch 会保存 token 和 API key 等敏感信息。请注意：

- Profile 中的验证信息会保存在本机应用数据目录
- 不要在不可信设备上使用
- 不要把应用数据目录、日志或 Profile 文件分享给他人
- 切换前建议先导入当前配置，保留一个可回退 Profile

首次切换时，底层会保留备份逻辑，用于降低误操作风险。

## 常见问题

### 切换后 Codex 没有变化怎么办？

请确认 Codex 桌面应用已经完全重启。若 Codex Switch 提示未找到 Codex 桌面应用路径，请手动关闭并重新打开 Codex。

### 为什么不直接启动 `codex` 命令？

`codex` 命令可能启动的是 CLI，而不是桌面应用。Codex Switch 只会尝试使用当前正在运行的 Codex 桌面应用可执行路径进行重启。

### 保存 Profile 会立刻影响 Codex 吗？

不会。保存只更新 Profile 数据。只有执行“切换”并确认后，才会写入 `~/.codex/auth.json` 和 `~/.codex/config.toml`。

### 自定义 Profile 只需要 API key 吗？

验证页只显示 `OPENAI_API_KEY`，但供应商页仍需要正确填写 provider 配置，尤其是 `model_provider`、`name` 和 `base_url`。

## 开发者信息

本项目基于 Electron、Vite、React、TypeScript 和 Vitest。

常用命令：

```bash
npm install
npm run dev
npm run lint
npm test
npm run build
```

Windows 打包：

```bash
npm run dist:win
```

目录结构：

```text
src/                 React 渲染进程
electron/main/       Electron 主进程、配置读写、进程管理
electron/preload.ts  preload IPC API
test/                Vitest 测试
```
