# dsh-updater 插件设计(npm + git 双形态自动更新)

日期:2026-09-09
状态:设计已与用户对齐;2026-09-10 修订(安装失败也纳入回滚触发;integrationsGlob → integrationsDir;M1 措辞改「无变更动作」);实现按 M1 计划推进(`docs/superpowers/plans/2026-09-09-dsh-updater-m1.md`)
落点:独立仓 `~/Projects/dsh-updater`(方案 B),以 `dsh plugin --profile web add github:<owner>/dsh-updater` 方式安装;本 spec 已随仓迁入 `docs/superpowers/specs/`(原起草于 vps-infra,2026-09-09 迁入)。

## 1. 背景与目标

DSH(DeepSeek Harness)快速迭代中,当前没有任何内置更新机制。社区已有两个同类插件:

- [dsh-self-upgrade](https://github.com/raomaiping-hash/dsh-self-upgrade):GitHub Releases 检测 + 备份 + `npm install -g` + idle-aware 重启 + Web 面板。❌ 硬性要求 Linux + systemd + 免密 sudo,macOS 不可用。
- [dsh-auto-update](https://github.com/a1113622001/dsh-auto-update):npm dist-tag 检测 + Stage(暂存)+ 退出后脱离子进程原子替换 + Web 胶囊 UI。✅ 跨平台,❌ 只认 npm 全局安装形态。

本机 DSH 是 **git checkout 源码形态**(`/Users/dmall/Projects/deepseek-harness`),npm 安装器对它无效。本插件**各取所长**:复用 dsh-auto-update 形态无关的生命周期(stage → 退出后应用 → idle 重启提示),更新动作按安装形态分发,同时支持 npm 与 git 两种安装形态,并覆盖 `~/.dsh/integrations/` 下插件仓的更新。

非目标:降级/版本回退到任意历史版本;Linux systemd 服务管理;插件市场自动上架流程。

## 2. 安装形态探测与分发

进程启动时探测一次,缓存到内存(每次 dsh 启动重新探测,不做持久化):

| 探测条件(按序) | 判定 | 更新策略 |
|---|---|---|
| harness 根目录(由 dsh 运行时 API 或 bin 路径回溯取得)存在 `.git/` 且存在 `pnpm-workspace.yaml` | **git 形态** | `git fetch origin` → 比对 `HEAD` 与 `@{upstream}` → 有新版则 `git pull --ff-only` → `pnpm install --frozen-lockfile` → `pnpm build` |
| `dsh` bin 经 realpath 解析落在 npm prefix 下,且所在包名为 `@deepseek-ai/dsh` | **npm 形态** | 查 registry dist-tag(默认 `latest`,可配)→ 有新版则下载 tarball 暂存到 `~/.dsh/updates/` → **主进程退出后**由脱离子进程执行替换 + 按原参数重启 |
| 两者都不满足 | 形态不明 | 只在 status 中报告,不执行任何更新动作 |

npm 形态的替换沿用社区已验证的生命周期:运行期只下载暂存(写 `pending-update.json`),`apply-update.js` 以 detached 子进程等父进程 PID 终止后再 `npm install -g <tarball>`,带 `apply.lock` 防并发。

## 3. Integrations(插件仓)更新

两种形态下都执行:枚举 `~/.dsh/integrations/*/` 中含 `.git` 的目录(如 superpowers),每项独立 `git fetch` 比对。与本体的检查/更新合并为一份清单,每项独立报告:`up-to-date` / `behind N commits` / `updated` / `diverged(需人工)` / `failed`。

## 4. 触发与安全模型

- **默认(确认门)**:启动时检查一次 + 每 30 分钟复查,只在会话/面板提示"有新版";用户在会话里说更新、调 `dsh_update_run`、或面板点按钮,才执行。检查与更新永远分离。
- **自动模式**:显式 opt-in(配置项 `autoApply: false` 默认关)。开启后发现新版先 stage,等 **idle 条件**(无运行中 background job 且会话日志静默 ≥ 2 分钟)才应用。
- **git 形态回滚**:`pull` 仅 `--ff-only`,本地有分叉(diverged)直接报错不自动 merge/rebase;`pnpm install --frozen-lockfile` 或 `pnpm build` 任一失败 → `git reset --hard ORIG_HEAD` 回原 commit 并报告。
- **npm 形态回滚**:替换前保留旧版安装目录副本,替换失败自动还原。
- **面板 API 只答 loopback**(`127.0.0.1`/`localhost`/`::1`),不进反代/隧道。特权操作为零(无 sudo)——npm 形态的 `npm install -g` 只写用户 prefix;若用户 prefix 需要提权,报告并让用户手动执行,不代做。

## 5. 交互面

### Agent 工具(cordis 插件注册)

| 工具 | 作用 |
|---|---|
| `dsh_update_status` | 本体(形态、当前版本、远端版本)+ 各 integration 仓的对比与状态;进行中任务的阶段;挂起的重启/应用 |
| `dsh_update_run` | 执行检查到的更新(本体按形态分发 + integrations 全量);返回逐步结果 |
| `dsh_update_cancel` | 取消挂起的自动应用/重启 |

### Web 面板(Settings → Plugins 下新屏)

- 本体 + 各插件版本胶囊(已最新 / 可升级 / 进行中 / 失败)。
- 按钮:检查更新 / 一键更新 / 取消。
- 更新完成后提示"重启 dsh 生效"——**不代重启**(macOS 无 systemd;git/dev 形态的重启命令在用户手里)。

## 6. 错误处理

- 网络/GitHub/npm registry 不可达:记日志,静默跳过本轮,下轮再试;连续失败不在会话里刷屏。
- 更新中任一步失败:停在该步 → 按第 4 节回滚 → 面板红点 + `dsh_update_status` 可查。**绝不留半更新状态**(git 形态以 commit 为原子单位,npm 形态以"暂存完整 tarball 后原子替换"保证)。
- `~/.dsh/integrations` 下非 git 目录:跳过并标注 `not-git`。

## 7. 配置(cordis.patch.yml insert,默认值)

```yaml
- insert:
    - id: dsh-updater
      name: dsh-updater
      config:
        checkOnStart: true
        checkIntervalMinutes: 30
        autoApply: false            # 自动应用,默认关(确认门)
        idleQuietMs: 120000         # 会话静默阈值
        npmDistTag: latest
        integrationsDir: '~/.dsh/integrations'  # 枚举其一级子目录,非 glob
```

## 8. 里程碑

1. **M1 检查与状态**:形态探测 + 本体/integrations 比对 + `dsh_update_status`。先交付,无变更动作(仅 fetch 与 registry 查询)。
2. **M2 git 形态更新**:确认后 pull + build + 回滚 + `dsh_update_run`。
3. **M3 npm 形态更新**:stage + 退出后应用 + 回滚。
4. **M4 面板与自动模式**:Web 屏、idle 感知自动应用、`dsh_update_cancel`。

## 9. 测试要点

- 形态探测:git/npm/未知三分支单测(fake 目录结构)。
- git 更新:临时 git 仓 fixture 走 ff/diverged/build 失败回滚三路。
- npm 替换:tarball 暂存校验 + `apply.lock` 并发互斥 + detached apply 脚本对"父进程已死/未死"两态的行为。
- 回归:每个 `dsh_update_*` 工具的输入校验(不接收自由路径,只操作探测出的固定目标)。
