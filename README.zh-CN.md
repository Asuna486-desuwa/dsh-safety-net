# dsh-safety-net

DeepSeek Harness (DSH) 的自保护安全护栏插件。当 agent 自主运行时，一次错误的写入可能悄悄毁掉 harness 本身——本插件让这种损害**默认不可能发生**，并且**一条命令即可回滚**。

> English docs: [README.md](./README.md)

## 为什么需要这个插件

DSH 自身的运行时状态以普通文件形式存放在 `~/.dsh`（profiles、会话状态、补丁）以及插件数据目录下。如果 agent 误判了沙箱边界，对这些文件执行 `write`/`edit`，就可能损坏 harness，甚至让你完全无法启动 DSH。`dsh-safety-net` 就是那条安全带：它对 DSH 关键资产实施硬拦截、在拒绝前先快照原文件，并保留一条即使 GUI 挂掉也能用的 CLI 自救通道。

## 四道安全护栏

### 1. 受保护路径守卫（硬拦截）

通过 `fs/write-intent` 与 `fs/edit-intent` 两个 waterfall 监听器，对命中 DSH 关键路径的任何变更实施硬拦截。默认受保护路径：

| 规则 id | 路径 |
| --- | --- |
| `dsh-home` | `~/.dsh`（DSH 数据根目录，可用 `$DSH_HOME` 覆盖） |
| `plugin-data` | `~/.claude/plugins/data/dsh-deepseek-dsh` |
| `profile-manifest` / `profile-patch` | `~/.dsh/profiles`（profile 清单与补丁） |
| `session-state` | `~/.dsh/state`（会话状态） |

被拦截的变更会抛出 `FS_POLICY_DENIED` 错误——agent 无法静默重试绕过去。还可以通过 `safetyNet.extraProtectedPaths` 追加额外路径（见[配置](#配置)）。

### 2. 破坏前备份

在拒绝写入受保护路径之前，会先把原文件快照进备份库。任何东西都不会被销毁：每一次被拦截的写/编辑操作都会留下可恢复的副本（除非快照本身失败），最坏情况也只需一条命令就能撤销。

### 3. CLI 自救通道

五个斜杠命令注册在 DSH CLI 表面上，即使 GUI 挂掉也能使用：

- `/safety-net-status` — 护栏健康报告（受保护规则数、备份数、strict 模式）
- `/safety-net-backup` — 手动全量快照受保护资产
- `/safety-net-restore` — 列出备份，或按 id 恢复指定备份
- `/safety-net-repair` — 检测缺失的关键文件并打印恢复指引
- `/safety-net-approve <path>` — 一次性批准写入受保护路径（授予单次放行，之后护栏重新武装）

详见[命令用法](#命令用法)。

### 4. strict 权限分级

strict 模式**默认开启**：safety-net *声明*一个只读的默认沙箱模式，并在宿主沙箱默认模式更宽（`workspace-write` / `danger-full-access`）时输出警告。这只是声明——实际强制执行仍由宿主沙箱后端负责，safety-net 无法强行改变宿主。只有在你理解代价时才关闭（`safetyNet.strict: false`）。

## 安装

要求 Node.js ≥ 20 和正在运行的 DeepSeek Harness（DSH）宿主。

> **依赖说明**：`@deepseek-ai/cordis` 与 `@deepseek-ai/dsh-fs` 声明为 **peer 依赖**——它们由 DSH 宿主运行时自带，不会从公开 npm 拉取（DSH 携带的 `dsh-fs` 版本在公开 npm 上可能不存在）。请在本插件的 DSH profile 内安装，**不要**单独 `npm install`。

**通过 npm 安装**：

```bash
dsh plugin add dsh-safety-net
```

**通过 git 安装**：

```bash
dsh plugin add git+https://github.com/Asuna486-desuwa/dsh-safety-net.git
```

**手动挂载**：clone 仓库后按 DSH 插件流程接入即可——`cordis.patch.yml` 已声明 bundle 补丁，`package.json` 自带 `dsh.bundle` 元数据。

## 配置

所有选项都在 `safetyNet` 键下：

```yaml
safetyNet:
  # strict 模式：声明默认沙箱模式为只读；宿主沙箱默认更宽时输出警告。默认值：true
  strict: true
  # 额外需要保护的路径（在内置 DSH 关键路径之外追加）
  extraProtectedPaths: []
  # 预留 — 按保留份数清理的接线将在后续版本接入。默认值：30
  backupRetention: 30
```

| 键 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `safetyNet.strict` | boolean | `true` | 声明默认沙箱模式为只读；宿主沙箱默认更宽（`workspace-write` / `danger-full-access`）时输出警告。 |
| `safetyNet.extraProtectedPaths` | string[] | `[]` | 视为 DSH 关键资产的额外路径。 |
| `safetyNet.backupRetention` | number | `30` | 备份库在 prune 前保留的最大快照数（预留；按保留份数清理的接线将在后续版本接入）。 |
| `safetyNet.dshHome` | string | 环境变量 `DSH_HOME` 或 `~/.dsh` | 覆盖 DSH 数据根目录（守卫、备份库与状态报告统一使用该值）。 |
| `safetyNet.pluginDataRoot` | string | `~/.claude/plugins/data` | 覆盖插件数据根目录（主要用于测试/注入）。 |

备份库创建于 `<DSH_HOME>/safety-net/backups/`。

## 命令用法

命令注册名不带斜杠（`safety-net-status` 等），下文以带 `/` 的形式展示，与 DSH UI/CLI 中的显示一致。

| 命令 | 行为 |
| --- | --- |
| `/safety-net-status` | 报告护栏健康：受保护规则数、已存备份数、strict 模式、解析出的 DSH home。 |
| `/safety-net-backup` | 手动把每个受保护资产快照进备份库。 |
| `/safety-net-restore` | 无参数时列出所有备份（新的在前）。 |
| `/safety-net-restore <id>` | 把指定备份 id 的文件恢复到原位置。 |
| `/safety-net-repair` | 检测缺失的关键文件并打印恢复指引（绝不自动修改任何东西）。 |
| `/safety-net-approve <path>` | 一次性批准写入受保护路径（调用 `guard.approveOnce`）；下一次匹配的写入放行后，护栏重新武装。 |

## 备份目录结构

```
<DSH_HOME>/safety-net/backups/
└── <时间戳id>/          # 例如 1750000000000-a1b2c3
    ├── _meta.json       # 记录每个快照文件对应的完整原始路径（含盘符）
    └── <相对路径>       # 原路径，去掉盘符，统一 '/' 分隔
```

每个快照是一个以时间 id 命名的目录；目录下保留原文件的相对路径，`_meta.json` 记录完整原始路径（含盘符），因此恢复时可以把每个文件精确放回它原来的位置——即使跨越 Windows 盘符也不会写错。

## 解除误拦截

如果一次合法的写入被拦截——比如你确实需要修改受保护路径下的文件——请注意：

- **一次性放行**：`/safety-net-approve <path>` 为该路径授予单次写入批准；下一次匹配的写入放行后，护栏重新武装（把 `guard.approveOnce` 接进了 CLI）。
- 通过 `safetyNet.extraProtectedPaths` 添加的路径**运行时只能加不能减**：想解除保护，请从配置中移除该条目并重启 DSH；
- 内置规则（`~/.dsh`、profiles、state、插件数据目录）无法通过配置移除。`strict` 只*声明*沙箱姿态，**不会**解除路径拦截。要修改内置受保护文件，请先卸载本插件（`dsh plugin remove dsh-safety-net`）完成修改后再装回。

## 自救手册（GUI 挂了怎么办）

如果 DSH 的 GUI 无法启动，或界面完全不可用，请按以下步骤在终端里自救：

```
1. 打开终端
2. 运行 dsh（进入 CLI）
3. /safety-net-status  —— 检查护栏与关键文件状态
4. /safety-net-restore —— 列出备份
5. /safety-net-restore <id> —— 恢复指定时间点的备份
6. 如果关键文件缺失：/safety-net-repair 查看恢复指引
```

> 提示：`/safety-net-restore` 不带参数会列出全部备份（新的在前），
> 用列表里的 id 作为参数即可精确恢复某个时间点。如果 `repair`
> 提示缺失文件且没有可用备份，按它的指引重新安装对应插件。

## 范围与免责声明

本插件**不做**以下事情：

- 不提供 GUI 面板——恢复能力放在 CLI 里，这样 GUI 挂掉时依然可用；
- 不做云端同步——备份只是 `<DSH_HOME>/safety-net/backups/` 下的本地文件；
- 不做文件*内容级* diff 恢复——恢复是整文件、按快照时间点进行的；
- 不拦截非关键路径的操作——只有 DSH 关键资产和你显式添加的路径受保护。

## 开发与测试

```bash
node --test tests/*.test.mjs
```

测试使用注入的 fake fs 适配器与注入的 `dshHome` / `pluginDataRoot` 覆盖——绝不会触碰你真实的 `~/.dsh`。

## 许可证

MIT
