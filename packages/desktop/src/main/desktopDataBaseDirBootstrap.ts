import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { setDataBaseDir } from "@zcode/services/node";
import { ZCODE_CREDENTIALS_FILE_ENV } from "@zcode/shared/credential-security";
import { isElectronAppPackaged } from "./desktopElectronApp.js";

/**
 * 其他 ZCode 实例注入、本 fork 任何场景都不应继承的运行态变量：官方实例的 endpoint 凭据、
 * /Applications 下官方 App 的 CUA helper 与搜索工具二进制、实例身份（版本/commit）、会话
 * 上下文与进程标签。从官方 App 内的终端（shell 快照注入整套 ZCODE_*）启动 dev 或打包版时，
 * 这些值会让本 fork 的子进程复用官方实例的资源与身份，破坏“与原版完全隔离”。
 * E2E（wdio.conf）不设置其中任何变量，不受影响。
 */
const INHERITED_INSTANCE_STATE_ENV_KEYS = [
  "ZCODE_OFFICIAL_ENDPOINT",
  "ZCODE_OFFICIAL_ENDPOINT_TOKEN",
  "ZCODE_CUA_BUNDLED_HELPER_APP_PATH",
  "ZCODE_CUA_LAUNCHER_PID",
  "ZCODE_BFS_BINARY",
  "ZCODE_RG_BINARY",
  "ZCODE_UGREP_BINARY",
  "ZCODE_PREINSTALLED_TOOLS_AVAILABLE",
  "ZCODE_APP_VERSION",
  "ZCODE_BUILD_COMMIT_ID",
  "ZCODE_SESSION_ID",
  "ZCODE_PROJECT_DIR",
  "ZCODE_GEN_UI_OUTPUT_ROOT",
  "ZCODE_PROCESS_LABEL",
  "ZCODE_CLIENT_LANGUAGE",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_SESSION_ID",
  "CLAUDE_PROJECT_DIR",
] as const;

/**
 * 清洗继承的其他 ZCode 实例运行态：
 * 1. 固定名单内的实例身份/凭据/资源路径变量一律删除（同 CR-01 模式：Desktop 不是它们的合法来源）。
 * 2. 任何值指向原版 `~/.zcode/` 的 `ZCODE_*` 变量删除——显式 provider 配置路径的优先级高于
 *    fork 自己的解析（desktopProviderConfig.ts），继承值会让打包版读原版 ~/.zcode 的配置文件。
 *    E2E 的 provider 配置指向仓库路径，不受此规则影响。
 */
function sanitizeInheritedInstanceStateEnv(): void {
  for (const key of INHERITED_INSTANCE_STATE_ENV_KEYS) {
    delete process.env[key];
  }
  const originalDataRootPrefix = join(homedir(), ".zcode") + sep;
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("ZCODE_") || !value?.trim().startsWith(originalDataRootPrefix)) {
      continue;
    }
    delete process.env[key];
  }
}

/** Dev 构建（Electron 未打包）专用的数据根目录名，与正式版 `~/.zcode` 物理隔离。 */
export const DEV_DATA_BASE_DIR_NAME = ".zcode-dev";

/**
 * 本 fork 打包版专用的数据根目录名。原版安装包使用 `~/.zcode`；fork 打包版代码级固定到
 * `~/.zcode-fork`，与原版安装（可能并排存在于同一台机器）完全隔离，不读不写 `~/.zcode`
 * （契约见 docs/development-mise-runtime.md「打包版数据隔离」）。
 */
export const FORK_DATA_BASE_DIR_NAME = ".zcode-fork";

export function resolveBootstrapSettingsFile(homePath: string = resolveSettingsHomeDir()): string {
  return join(homePath, ".zcode", "v2", "setting.json");
}

/**
 * setting.json 引导读取的锚定 HOME：打包版用 fork 数据根（`~/.zcode-fork/.zcode/v2/setting.json`），
 * 从根上切断对原版 `~/.zcode/v2/setting.json` 的读取；未打包保持 homedir（dev 分支固定
 * `~/.zcode-dev`，不经过此读取路径）。
 */
function resolveSettingsHomeDir(): string {
  return isElectronAppPackaged() ? resolveForkDataBaseDir() : homedir();
}

export function extractBootstrapDataBaseDir(rawValue: unknown): string | null {
  if (!rawValue || typeof rawValue !== "object") {
    return null;
  }

  const dataBaseDir = (rawValue as { dataBaseDir?: unknown }).dataBaseDir;
  if (typeof dataBaseDir !== "string") {
    return null;
  }

  const trimmed = dataBaseDir.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readBootstrapDataBaseDirFromDisk(
  settingsFile: string = resolveBootstrapSettingsFile(),
): string | null {
  if (!existsSync(settingsFile)) {
    return null;
  }

  try {
    const raw = readFileSync(settingsFile, "utf-8");
    return extractBootstrapDataBaseDir(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * Dev 构建（`app.isPackaged === false`）的数据根永远固定在 `~/.zcode-dev`；本 fork 的打包版
 * 数据根永远固定在 `~/.zcode-fork`。两者都与原版 `~/.zcode` 物理隔离，不依赖启动脚本注入 env。
 * 显式 `ZCODE_DATA_BASE_DIR` 仍然优先：E2E 用它指向隔离 home。
 */
export function applyEarlyDataBaseDirBootstrap(): string | null {
  // Bug 原因（评审 CR-01）：ZCODE_CREDENTIALS_FILE 是 Source Server Core 的进程装配，凭据路径解析
  // 会优先采用它。Desktop 从设置了该变量的 shell / launchctl 环境启动时，Main cipher、Host 凭据服务
  // 与 Agent 会整体改用外部指定的凭据库（例如 Server 自有库）。Desktop 不是该变量的合法来源，
  // 在任何凭据读写方创建、Host fork 之前删除一次，Main、Host 与 Agent 都只用 Desktop 数据根。
  delete process.env[ZCODE_CREDENTIALS_FILE_ENV];
  // 先清洗继承的其他 ZCode 实例运行态（官方 App 终端 shell 注入的 ZCODE_*/CLAUDE_* 变量），
  // 再做本进程的数据根固定，避免继承值污染 dev / fork 打包根下的子进程。
  sanitizeInheritedInstanceStateEnv();
  if (!isElectronAppPackaged()) {
    return applyDevDataBaseDirBootstrap();
  }
  // fork 契约：打包版不再读原版 ~/.zcode/v2/setting.json，固定 fork 根；显式 env 与 fork 根下
  // setting.json 的 dataBaseDir 引导仍可用（优先级见 resolveForkDataBaseDir 与下方注释）。
  return applyForkDataBaseDirBootstrap();
}

/** Dev 数据根：显式 env 覆盖（E2E / CI），否则固定 `~/.zcode-dev`。 */
export function resolveDevDataBaseDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.ZCODE_DATA_BASE_DIR?.trim() || join(homedir(), DEV_DATA_BASE_DIR_NAME);
}

/**
 * Fork 打包版数据根：显式 env 覆盖（E2E / CI），否则固定 `~/.zcode-fork`。
 * 与 resolveDevDataBaseDir 平行；注意它同时是 setting.json 引导读取的锚定 HOME
 * （resolveSettingsHomeDir），因此该函数不含 setting.json 的 dataBaseDir 引导，
 * 引导由 applyForkDataBaseDirBootstrap 单独组合，避免读设置与定根互相递归。
 */
export function resolveForkDataBaseDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.ZCODE_DATA_BASE_DIR?.trim() || join(homedir(), FORK_DATA_BASE_DIR_NAME);
}

/** 隔离数据根下 agent CLI 会话库的位置；与 CLI 默认布局 `~/.zcode/cli/db/db.sqlite` 同构。 */
export function resolveDevAgentSessionDbPath(dataBaseDir: string): string {
  return join(dataBaseDir, ".zcode", "cli", "db", "db.sqlite");
}

function applyDevDataBaseDirBootstrap(): string {
  return applyIsolatedDataBaseDirBootstrap(resolveDevDataBaseDir());
}

function applyForkDataBaseDirBootstrap(): string {
  // 优先级：显式 ZCODE_DATA_BASE_DIR（E2E/CI） > fork 根下 setting.json 的 dataBaseDir 引导
  // （读取 ~/.zcode-fork/.zcode/v2/setting.json，保持用户自定义数据根的能力）> 固定 ~/.zcode-fork。
  // 原版 ~/.zcode 在任何优先级层级都不被探测。
  const dataBaseDir =
    process.env.ZCODE_DATA_BASE_DIR?.trim() ||
    readBootstrapDataBaseDirFromDisk() ||
    resolveForkDataBaseDir();
  return applyIsolatedDataBaseDirBootstrap(dataBaseDir);
}

/**
 * 隔离数据根的四注入 + setDataBaseDir，Dev 与 fork 打包版共用同一实现，保证两侧语义不分叉。
 */
function applyIsolatedDataBaseDirBootstrap(dataBaseDir: string): string {
  // Agent CLI 的会话库默认锚定真实 HOME（~/.zcode/cli/db/db.sqlite），不随数据根迁移；
  // tasks-index 只是它的同步投影，不注入会与原版共用任务列表事实源。CLI 的 env-config
  // adapter 认这两个变量。
  process.env.ZCODE_DATA_BASE_DIR = dataBaseDir;
  process.env.ZCODE_SESSION_DB_PATH = resolveDevAgentSessionDbPath(dataBaseDir);
  // 用户级 HOME 锚定目录（AGENTS.md / 用户 skills / 全局 workflows / CLI config.json /
  // mailbox / .claude 集成）的统一契约，App 与 CLI 两侧经 @zcode/shared/user-data-home
  // 同源解析，彻底与原版 ~/.zcode 隔离。
  process.env.ZCODE_USER_HOME = dataBaseDir;
  // storage.dir 是 agent 侧绝大多数数据根的锚点（contracts 默认字面量 `~/.zcode`）：
  // 子 agent 持久记忆（提示词里的 <MEMORY_ROOT> = {storageRoot}/agent-memory/<agent>）、
  // 子 agent profiles/state、image/pdf 缓存、artifacts 都从它派生。env 补丁在合成顺序里
  // 高于用户 config.json，注入后这些路径全部落到隔离根。
  // 仍按设计锚定真实 HOME、不随 storage.dir 迁移的：全局 workflows（机器级共享）、
  // 用户级 AGENTS.md 与 skills（App/CLI 契约路径），提示词与运行时一致，无路径分叉。
  process.env.ZCODE_STORAGE_DIR = join(dataBaseDir, ".zcode");
  setDataBaseDir(dataBaseDir);
  return dataBaseDir;
}
