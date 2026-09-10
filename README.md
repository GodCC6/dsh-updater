# dsh-updater

DeepSeek Harness (DSH) 的双形态自动更新插件：支持 git checkout 与 npm 全局安装两种形态的自动更新。M1 里程碑为只读检查（仅加载并输出检查配置，不执行任何更新动作）。

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
