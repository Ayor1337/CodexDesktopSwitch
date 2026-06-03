# Codex Switch Electron Agent Guide

## 项目概览

这是一个 Electron 桌面应用，用于管理和切换 Codex 的账号与供应商配置。

目标文件：

- `~/.codex/auth.json`
- `~/.codex/config.toml`

核心功能：

- 新建、导入、编辑、删除 profile
- 在 `Official OpenAI OAuth` 与 `自定义` 类型之间切换
- 切换 profile 时写入 `auth.json` 和 `config.toml`
- 切换前要求用户确认
- 确认后关闭 Codex / extension-host 相关进程，并尝试重启当前运行的 Codex 桌面应用

## 技术栈

- Electron
- Vite
- React
- TypeScript
- Vitest
- `@iarna/toml`
- `lucide-react`

## 目录结构

- `src/`
  - React 渲染进程代码
  - `src/App.tsx` 是主界面和交互逻辑
  - `src/types.ts` 定义 renderer 与 preload 共享类型
- `electron/main/`
  - Electron 主进程逻辑
  - `service.ts` 负责 profile 操作
  - `codex.ts` 负责 auth/config 读写
  - `processes.ts` 负责关闭并重启 Codex 进程
  - `backup.ts` 当前 UI 不展示，但底层仍保留首次切换备份逻辑
- `electron/preload.ts`
  - 暴露 `window.codexSwitch` API
- `test/`
  - Vitest 单元与集成测试

## 常用命令

```bash
npm run dev
npm run lint
npm test
npm run build
```

在当前环境中，`npm test` 和 `npm run build` 可能需要提升权限，因为 Vitest / esbuild 需要启动子进程。

## 重要约束

- 所有用户可见回复和任务说明使用中文。
- 保持 KISS，避免引入复杂状态管理或过度抽象。
- renderer 不直接访问 Node 文件系统，只通过 preload 暴露的 IPC API。
- profile 存储使用 Electron `app.getPath("userData")/profiles.json`，不复用 CLI 版 `~/.config/csw/profiles.json`。
- 内部类型值保持：
  - `official`
  - `custom`
- UI 显示文案：
  - `official` 显示为 `Official OpenAI OAuth`
  - `custom` 显示为 `自定义`

## 切换语义

`Official OpenAI OAuth`：

- 写入 `auth.json`
- 从 `config.toml` 顶层移除 `model_provider`
- 保留已有 `model_providers` 表

`自定义`：

- 写入 `auth.json`
- 设置顶层 `model_provider`
- 写入对应 `[model_providers.<name>]`

## UI 约定

- 左侧：
  - 新建 Profile
  - 导入当前配置
  - profile 列表
- profile 支持：
  - 单击选择
  - 双击触发切换确认
  - 右键打开重命名 / 删除菜单
- 右侧：
  - 当前工作区
  - 类型和 Profile 名称使用独立卡片
  - `验证 / 供应商` 使用顶部 tab
- 右下角悬浮图标按钮：
  - 切换
  - 保存
  - 刷新

## 验证页

- `Official OpenAI OAuth` 显示：
  - `OPENAI_API_KEY`
  - `id_token`
  - `access_token`
  - `refresh_token`
- `自定义` 只显示：
  - `OPENAI_API_KEY`
- 敏感字段默认显示前 4 位和后 4 位。
- 聚焦输入框时显示完整值，失焦后恢复掩码。
- `null`、`undefined`、空字符串不视为敏感值，不显示掩码。
- `auth.json` 原文编辑默认折叠。

## 供应商页

- 使用 form 风格编辑：
  - `model_provider`
  - `name`
  - `base_url`
  - `env_key`
- `Provider TOML` 原文编辑默认折叠。
- 表单编辑需要同步更新 TOML 文本。
- TOML 文本编辑后需要同步更新表单字段。

## 进程重启逻辑

切换确认后：

1. 写入目标 profile
2. 查找正在运行的 Codex 桌面应用可执行路径
3. 关闭：
   - `codex.exe`
   - `extension-host.exe`
   - `extensionHost.exe`
4. 使用找到的桌面 exe 路径重启 Codex

不要使用 `spawn("codex")`，这会启动 CLI。

如果找不到 Codex 桌面应用路径，应提示用户手动重启 Codex，不要 fallback 到 CLI。

## 注意事项

- 修改 preload API 后必须完全重启 Electron 应用，热更新通常不会刷新 preload。
- 修改 UI 后至少运行：

```bash
npm run lint
npm run build
```

- 修改业务逻辑后运行：

```bash
npm test
```

