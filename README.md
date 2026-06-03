# Codex Desktop Switch

一个用于快速切换 Codex 桌面应用账号与供应商配置的 Electron 工具。

它管理用户目录下的：

- `~/.codex/auth.json`
- `~/.codex/config.toml`

## 功能

- 管理多个 Profile
- 支持导入当前 `.codex` 配置
- 支持两种类型：
  - `Official OpenAI OAuth`
  - `自定义`
- 切换 Profile 时写入 `auth.json` 和 `config.toml`
- 双击 Profile 可触发切换
- 切换前弹窗确认
- 确认切换后关闭 Codex / extension-host 相关进程，并尝试重启当前运行的 Codex 桌面应用
- Profile 支持右键重命名和删除
- 验证与供应商配置支持表单编辑
- `auth.json` 和 `Provider TOML` 原文编辑默认折叠，可手动展开

## 类型说明

### Official OpenAI OAuth

切换时：

- 写入 `auth.json`
- 移除 `config.toml` 顶层 `model_provider`
- 保留已有 `model_providers` 表

### 自定义

切换时：

- 写入 `auth.json`
- 设置 `config.toml` 顶层 `model_provider`
- 写入对应 `[model_providers.<name>]`

自定义类型的验证页只显示 `OPENAI_API_KEY`。

## 开发

```bash
npm install
npm run dev
```

## 验证

```bash
npm run lint
npm test
npm run build
```

## 项目结构

```text
src/                 React 渲染进程
electron/main/       Electron 主进程、配置读写、进程管理
electron/preload.ts  preload IPC API
test/                Vitest 测试
```

## 注意

- Profile 存储在 Electron `userData/profiles.json`，不复用 CLI 版 `~/.config/csw/profiles.json`。
- Profile 会明文保存 token/API key，请只在可信设备上使用。
- 修改 preload API 后需要完全重启 Electron 应用。
- 重启 Codex 时不会调用 `codex` CLI，而是尝试使用当前正在运行的 Codex 桌面应用可执行路径。
