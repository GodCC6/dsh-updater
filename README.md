# dsh-updater

[![CI](https://github.com/GodCC6/dsh-updater/actions/workflows/ci.yml/badge.svg)](https://github.com/GodCC6/dsh-updater/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
![Node](https://img.shields.io/badge/node-%3E%3D20-green)

**Auto-update plugin for DeepSeek Harness (DSH)** — keeps a git-checkout or npm-global dsh installation and its integration repos up to date, with fast-forward-only pulls, automatic rollback, and no surprise restarts.

自动更新 dsh 的插件：同时支持 **git checkout 与 npm 全局**两种安装形态，并覆盖 `~/.dsh/integrations/` 下的 integration 仓库（兼容 `<name>/` 与 `<name>/repo/` 两种布局）。

## 功能

- **状态检查** `dsh_update_status`：安装形态探测（git / npm / 未知）、harness 本体与各 integration 仓的 behind 比对、进行中/最近一次更新任务的进度与结果。
- **手动更新** `dsh_update_run`：后台 job 执行更新。git 形态为 `git pull --ff-only` → `pnpm install --frozen-lockfile` → `pnpm build`；integration 仓逐仓 ff-only、互不影响。
- **取消更新** `dsh_update_cancel`：随时取消进行中的更新，自动回滚已完成的部分步骤，后台 job 结算为 killed。
- **自动模式**（可选，`autoApply: true`）：定时检查发现新版且系统空闲（无运行 job 且会话静默 ≥ `idleQuietMs`）时自动应用；diverged / dirty 的目标只报告不动；同一版本失败后不重复尝试。

## 安全模型

- **检查与更新分离**：默认只提示「有新版」，执行更新需显式调用 `dsh_update_run`；自动模式默认关闭。
- **只快进不合并**：pull 仅 `--ff-only`，本地分叉（diverged）直接报告，绝不自动 merge/rebase。
- **失败即回滚**：install/build 任一步失败自动 `git reset --hard` 回到更新前 commit，绝不留半更新状态。
- **绝不代重启**：更新完成后仅置 `pendingRestart` 提示，重启 dsh 的动作永远在你手里。
- **零特权、零依赖**：无 sudo，只写用户目录；纯 Node 内置模块，无任何第三方依赖。

## 安装

```bash
# 从 GitHub 安装
dsh plugin --profile web add github:GodCC6/dsh-updater

# 或本地路径安装
dsh plugin --profile web add ~/Projects/dsh-updater
```

## 配置

默认值定义在 `cordis.patch.yml` 的 patch 行中：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `checkOnStart` | `true` | 插件启动时是否立即检查更新 |
| `checkIntervalMinutes` | `30` | 定时检查间隔（分钟） |
| `autoApply` | `false` | 检测到更新后是否自动应用 |
| `idleQuietMs` | `120000` | 空闲静默阈值（毫秒） |
| `npmDistTag` | `latest` | npm 形态更新所用的 dist-tag |
| `integrationsDir` | `~/.dsh/integrations` | integrations 目录路径 |

## Roadmap

- [ ] npm 形态自动更新（stage → 退出后原子替换 → 失败回滚）
- [ ] Web 面板（Settings → Plugins 下的版本胶囊、检查/更新/取消按钮）

## 开发

```bash
npm test   # node --test,零第三方依赖,Node >= 20
```

设计文档见 `docs/superpowers/specs/`，各里程碑实现计划见 `docs/superpowers/plans/`。

## License

[MIT](./LICENSE)
