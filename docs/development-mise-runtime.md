# mise 开发运行时

## 背景

仓库根目录和 `apps/zcode-cli` 都依赖 Node / pnpm 版本一致性。此前根目录只在 `package.json` 的 `engines.node` 标注 `>=24.0.0`，而 Agent 子工程通过 `.node-version` 和 `packageManager` 固定到 Node `24.14.0`、pnpm `10.33.2`。新机器或新 worktree 容易先装错运行时，再在 Electron、Vite 或 Agent 构建阶段暴露问题。

## 目标

- 进入仓库后可以通过 `mise install` 准备开发运行时。
- `mise run dev` 默认启动桌面测试环境，便于本地开发。
- `mise run dev` 使用独立的数据根目录，避免与正式安装包共享账号凭据、设置和任务索引。
- 常用 Web、桌面生产环境、远控调试和校验命令都有稳定别名。
- 不改变现有 pnpm scripts 的真实执行逻辑，mise 只做版本和入口编排。
- mise 是可选开发入口，Git pre-push 不要求安装 mise；推送使用当前环境中的 Node / pnpm，详见 [Pre-push Hook](testing/pre-push-hook.md#开发环境与版本管理工具)。

## 约定

- Node 固定为 `24.14.0`，与 `apps/zcode-cli/.node-version` 保持一致。
- pnpm 固定为 `10.33.2`，与 `apps/zcode-cli/package.json` 的 `packageManager` 保持一致。
- Electron 安装阶段通过 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 下载，避免首次安装依赖时直连 GitHub release 超时。
- 任务入口仍调用根目录 `package.json` 中已有脚本，避免 desktop / web / agent 的启动语义分叉。
- `dev` 任务调用 `pnpm dev:desktop:test`。Dev 构建（`app.isPackaged === false`）的数据根由
  `desktopDataBaseDirBootstrap` 代码级固定到 `$HOME/.zcode-dev`，实际应用数据落到
  `$HOME/.zcode-dev/.zcode/`；mise 不再注入 `ZCODE_DATA_BASE_DIR`（2026-11 恢复被
  3996dcbdb3 回滚的行为，见下节）。
- Dev 隔离同时覆盖 agent CLI 数据根：dev 启动向子进程注入
  `ZCODE_SESSION_DB_PATH=$HOME/.zcode-dev/.zcode/cli/db/db.sqlite`（会话库；tasks-index
  只是它的同步投影）、`ZCODE_STORAGE_DIR=$HOME/.zcode-dev/.zcode`（storage.dir 锚点，
  驱动子 agent 持久记忆 `<MEMORY_ROOT>`、subagent profiles/state、缓存与 artifacts），
  以及 `ZCODE_USER_HOME=$HOME/.zcode-dev`（用户级 HOME 锚定路径的统一契约：
  AGENTS.md、用户级 skills、`.agents/skills` 兼容目录、全局 workflows、CLI
  config.json 与 workspace-hook trust store、mailbox、`.claude` 集成目录，
  App 与 CLI 两侧经 `@zcode/shared/user-data-home` 同源解析）。
- Dev 数据目录不会从正式环境自动复制凭据、设置、任务历史或插件状态；首次启动需要重新登录和配置。
- 显式 `ZCODE_DATA_BASE_DIR` 仍然优先于代码默认值（E2E 用它指向隔离 home）；需要临时
  覆盖时直接设置该变量即可。
- 生产环境桌面启动使用 `dev-desktop-prod`。`dev-desktop-prod` 与 `dev:desktop:test` 都是
  未打包运行，同样落在 `~/.zcode-dev`。
- **打包版数据隔离（fork 契约）**：本 fork 打包出的安装包（`app.isPackaged === true`，
  任意产品身份）数据根代码级固定到 `$HOME/.zcode-fork`，与原版 `~/.zcode` 完全隔离、
  全程不读不写。四注入与 Dev 同构：`ZCODE_DATA_BASE_DIR=$HOME/.zcode-fork`、
  `ZCODE_SESSION_DB_PATH=$HOME/.zcode-fork/.zcode/cli/db/db.sqlite`、
  `ZCODE_STORAGE_DIR=$HOME/.zcode-fork/.zcode`、`ZCODE_USER_HOME=$HOME/.zcode-fork`，
  实际数据全部落在 `$HOME/.zcode-fork/.zcode/`（settings、tasks-index、crash、
  预装工具 preinstalled-tools、会话库、storage 派生路径、AGENTS.md/skills/workflows/
  config.json/mailbox 等）。
- 打包版优先级：显式 `ZCODE_DATA_BASE_DIR`（E2E/CI） > **fork 根下** `setting.json` 的
  `dataBaseDir` 引导（读取 `$HOME/.zcode-fork/.zcode/v2/setting.json`，不再读原版
  `~/.zcode/v2/setting.json`） > 固定 `$HOME/.zcode-fork`。原版 `~/.zcode` 在任何优先级
  层级都不再被探测。
- 打包版隔离不迁移原版数据：首次启动是全新环境，需要重新登录和配置。
- **继承运行态清洗（dev 与打包版共用）**：从官方 ZCode 内的终端启动时（shell 快照注入整套
  `ZCODE_*`/`CLAUDE_*` 运行态变量），早期 bootstrap 会先清洗继承值再做数据根固定：
  1) 实例身份/凭据/资源变量一律删除（`ZCODE_OFFICIAL_ENDPOINT(_TOKEN)`、`ZCODE_CUA_*`、
  `ZCODE_BFS/RG/UGREP_BINARY`、`ZCODE_PREINSTALLED_TOOLS_AVAILABLE`、`ZCODE_APP_VERSION`、
  `ZCODE_BUILD_COMMIT_ID`、`ZCODE_SESSION_ID`、`ZCODE_PROJECT_DIR`、`ZCODE_GEN_UI_OUTPUT_ROOT`、
  `ZCODE_PROCESS_LABEL`、`ZCODE_CLIENT_LANGUAGE`、`CLAUDE_*` 会话上下文）；
  2) 任何值指向原版 `~/.zcode/` 的 `ZCODE_*` 变量删除（显式 provider 配置路径优先级高于
  App 自己的解析，继承值会让打包版读原版配置）。E2E 不受影响：其 provider 配置指向仓库路径，
  `ZCODE_DESKTOP_*`、`ZCODE_DATA_BASE_DIR`、`ZCODE_OFFPEAK_*`、`ZCODE_CREDENTIAL_SECRET` 等
  测试变量不在清洗范围。
- CLI 侧默认路径同根：`cli/log` 与 `cli/memory-diagnostics` 经 `resolveUserDataHome`
  （`ZCODE_USER_HOME` 契约）解析，不再硬编码 `homedir()`。
- **main 入口 import 顺序约束**：`desktopEarlyDataBaseDirBootstrap.js` 必须是 `main/index.ts`
  的第一个 import。main 的 `logger.ts` 在模块求值阶段就会 `mkdir(getAppConfigDir()/logs)`，
  而它可经 `preinstalled-tools → resourceManagerWindow → logger` 的依赖链被文件靠前的业务
  import 提前求值；隔离注入若晚于该链执行，日志目录会按默认 HOME 兜底建到原版
  `~/.zcode/v2/logs`（dev 与打包版同样受影响）。新增 main 顶部 import 时不得排到它之前。
- 数据目录隔离不改变 OAuth 回调协议。正式包与 Dev 仍使用 `zcode://`，因此 Dev 登录时应先退出其他 ZCode 实例，避免回调被错误进程接收。

## 与 3996dcbdb3 回滚的关系

`3996dcbdb3`（revert storage-profile 系列）曾撤掉源码 Desktop 按 `app.isPackaged=false`
自动选 `$HOME/.zcode-dev/` 的能力，此后 mise 注入 `ZCODE_DATA_BASE_DIR` 是唯一的隔离手段。
2026-11 应用要求 Dev 构建永远与正式版隔离，恢复代码级固定：`desktopDataBaseDirBootstrap`
在未打包运行时强制 `~/.zcode-dev` 并注入 agent 会话库路径；mise env 不再承担隔离职责。
`$HOME/.zcode-dev-home`（mise 时代的旧目录）不再被任何启动路径使用，可手动清理。

## 验证

- `mise install`
- `mise run bootstrap`
- `mise run dev`
- `mise run typecheck`
- `mise run lint`
