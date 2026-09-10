# dsh-updater

DeepSeek Harness (DSH) 的双形态自动更新插件：支持 git checkout 与 npm 全局安装两种形态的自动更新。M1 里程碑为只读检查（仅加载并输出检查配置，不执行任何更新动作）。

## 更新行为（M2）

从 M2 起，可通过 `dsh_update_run` 触发 git 形态更新：harness 本体执行 `git pull --ff-only` + `pnpm install --frozen-lockfile` + `pnpm build`，install/build 失败时自动 `git reset --hard` 回滚；integrations 目录下的仓库逐仓 ff-only 更新、互不影响。更新以后台 job 运行，进度与结果通过 `dsh_update_status` 输出的 `update` 字段查看。更新完成后需重启 dsh 才能应用新构建。npm 形态更新计划在 M3 提供。

## 取消与自动应用（M4）

M4 起新增 `dsh_update_cancel` 工具，可随时取消进行中的更新：harness 触发回滚（`git reset --hard ORIG_HEAD`），对应后台 job 结算为 killed。开启 `autoApply: true` 后，每轮定时检查发现新版且系统处于 idle 状态（无运行中 job 且会话静默时长 ≥ `idleQuietMs`）时，插件自动执行更新；diverged 或 dirty 的目标仍只报告、不动；同一版本已尝试失败后不重复触发。自动更新完成后，`dsh_update_status` 的 `update.pendingRestart` 字段会置为 `true` 提示重启——插件绝不代重启 dsh。

## 安装

```bash
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
