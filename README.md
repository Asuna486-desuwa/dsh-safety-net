# dsh-safety-net

Self-protection guardrails for the DeepSeek Harness (DSH). When an agent runs
autonomously, a wrong write can silently destroy the harness itself — this
plugin makes that damage **impossible by default** and **reversible by
command**.

> 中文文档见 [README.zh-CN.md](./README.zh-CN.md) · Chinese docs live in
> [README.zh-CN.md](./README.zh-CN.md)

## Why this plugin exists

DSH's own runtime state lives in plain files under `~/.dsh` (profiles,
session state, patches) and under the plugin data directory. An agent that
misreads its sandbox boundaries can `write`/`edit` those files, corrupt the
harness, and leave you unable to start DSH at all. `dsh-safety-net` is the
seatbelt: it hard-blocks mutations on DSH critical assets, snapshots files
before refusing, and keeps a CLI recovery channel that works even when the
GUI is gone.

## The four guardrails

### 1. Protected-path guard (hard interception)

`fs/write-intent` and `fs/edit-intent` waterfall listeners hard-block any
mutation that targets a DSH critical path. Protected by default:

| Rule id        | Path                                                |
| -------------- | --------------------------------------------------- |
| `dsh-home`     | `~/.dsh` (the DSH data root, `$DSH_HOME` override)  |
| `plugin-data`  | `~/.claude/plugins/data/dsh-deepseek-dsh`           |
| `profile-manifest` / `profile-patch` | `~/.dsh/profiles` (profile manifests & patches) |
| `session-state`| `~/.dsh/state` (session state)                      |

A blocked mutation raises an `FS_POLICY_DENIED` error — the agent cannot
silently retry its way past it. Extra paths can be added via
`safetyNet.extraProtectedPaths` (see [Configuration](#configuration)).

### 2. Backup before destroy

Before a protected path is refused, the original file is snapshotted into the
backup store. Nothing is ever destroyed: every blocked write/edit leaves a
restorable copy behind, so the worst case is one command away from being
undone.

### 3. CLI self-recovery channel

Four slash commands, registered on the DSH CLI surface, work even when the
GUI is down:

- `/safety-net-status` — guardrail health report (protected rules, backups, strict mode)
- `/safety-net-backup` — manual full snapshot of protected assets
- `/safety-net-restore` — list backups, or restore one by id
- `/safety-net-repair` — detect missing critical files and print recovery instructions

See [Commands](#commands) for details.

### 4. Strict privilege tiering

Strict mode is **on by default**: the effective default sandbox mode becomes
`read-only`, so even code paths that never consult the guard start from a
non-destructive posture. Turn it off only if you understand the trade-off
(`safetyNet.strict: false`).

## Installation

Requires Node.js ≥ 20.

**From npm** (once published):

```bash
dsh plugin add dsh-safety-net
```

**From git**:

```bash
dsh plugin add git+https://github.com/Asuna486-desuwa/dsh-safety-net.git
```

**Manual mount**: clone the repository and wire it into your DSH plugin flow
as usual — `cordis.patch.yml` already declares the bundle patch, and
`package.json` carries the `dsh.bundle` metadata.

## Configuration

All options live under the `safetyNet` key:

```yaml
safetyNet:
  # Strict mode: default sandbox mode is read-only. Default: true
  strict: true
  # Additional paths to protect (beyond the built-in DSH critical paths)
  extraProtectedPaths: []
  # How many snapshots to keep before pruning old backups. Default: 30
  backupRetention: 30
```

| Key                    | Type     | Default         | Description                                              |
| ---------------------- | -------- | --------------- | -------------------------------------------------------- |
| `safetyNet.strict`     | boolean  | `true`          | Default sandbox mode is `read-only` when enabled.        |
| `safetyNet.extraProtectedPaths` | string[] | `[]`   | Extra paths treated as DSH critical assets.              |
| `safetyNet.backupRetention` | number | `30`        | Max snapshots kept in the backup store before pruning.   |
| `safetyNet.dshHome`    | string   | env `DSH_HOME` or `~/.dsh` | Override the DSH data root (used by the guard, the backup store and the status report alike). |
| `safetyNet.pluginDataRoot` | string | `~/.claude/plugins/data` | Override the plugin data root (mainly for tests/injection). |

The backup store is created under `<DSH_HOME>/safety-net/backups/`.

## Commands

Command names are registered without a slash (`safety-net-status`, ...) and
are shown below with a leading `/` as they appear in the DSH UI/CLI.

| Command                          | Behavior                                                                 |
| -------------------------------- | ------------------------------------------------------------------------ |
| `/safety-net-status`             | Reports guardrail health: number of protected rules, stored backups, strict mode, and the resolved DSH home. |
| `/safety-net-backup`             | Manually snapshots every protected asset into the backup store.          |
| `/safety-net-restore`            | With no argument, lists all backups (newest first).                      |
| `/safety-net-restore <id>`       | Restores the files of the given backup id to their original locations.   |
| `/safety-net-repair`             | Detects missing critical files and prints recovery instructions (never auto-modifies anything). |

## Backup layout

```
<DSH_HOME>/safety-net/backups/
└── <timestamp-id>/          # e.g. 1750000000000-a1b2c3
    └── <relative-path>      # original path, drive letter stripped, '/' separators
```

Each snapshot is one directory named by a time-based id; the original relative
path is preserved beneath it, so restore can put every file back exactly where
it was.

## Scope & disclaimer

This plugin intentionally does **not**:

- provide a GUI panel — recovery lives in the CLI, where it still works when
  the GUI is down;
- sync backups to the cloud — backups are local files under
  `<DSH_HOME>/safety-net/backups/`;
- restore file *content* diffs — restore is whole-file, snapshot-point based;
- intercept operations on non-critical paths — only DSH critical assets and
  paths you explicitly add are protected.

## Development & testing

```bash
node --test tests/*.test.mjs
```

Tests run against an injected fake fs adapter and injected `dshHome` /
`pluginDataRoot` overrides — they never touch your real `~/.dsh`.

## License

MIT
