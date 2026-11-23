import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setDataBaseDir } from "@zcode/services/node";
import { ZCODE_CREDENTIALS_FILE_ENV } from "@zcode/shared/credential-security";
import { isElectronAppPackaged } from "./desktopElectronApp.js";

/** Dev 构建（Electron 未打包）专用的数据根目录名，与正式版 `~/.zcode` 物理隔离。 */
export const DEV_DATA_BASE_DIR_NAME = ".zcode-dev";

export function resolveBootstrapSettingsFile(homePath: string = homedir()): string {
  return join(homePath, ".zcode", "v2", "setting.json");
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
 * Dev 构建（`app.isPackaged === false`）的数据根永远固定在 `~/.zcode-dev`，与正式版
 * `~/.zcode` 物理隔离，不依赖启动脚本注入 env（此前 mise 注入是唯一隔离手段，绕过
 * mise 直接 `pnpm dev:desktop` 就会写进真实 `~/.zcode`）。显式 `ZCODE_DATA_BASE_DIR`
 * 仍然优先：E2E 用它指向隔离 home。
 */
export function applyEarlyDataBaseDirBootstrap(): string | null {
  // Bug 原因（评审 CR-01）：ZCODE_CREDENTIALS_FILE 是 Source Server Core 的进程装配，凭据路径解析
  // 会优先采用它。Desktop 从设置了该变量的 shell / launchctl 环境启动时，Main cipher、Host 凭据服务
  // 与 Agent 会整体改用外部指定的凭据库（例如 Server 自有库）。Desktop 不是该变量的合法来源，
  // 在任何凭据读写方创建、Host fork 之前删除一次，Main、Host 与 Agent 都只用 Desktop 数据根。
  delete process.env[ZCODE_CREDENTIALS_FILE_ENV];
  if (!isElectronAppPackaged()) {
    return applyDevDataBaseDirBootstrap();
  }
  const dataBaseDir = readBootstrapDataBaseDirFromDisk();
  if (dataBaseDir) {
    // 启动早期就把 dataBaseDir 注入进来，避免 logger / crashReporter 先按默认 HOME 建目录，
    // 导致后续再切换到自定义目录时，日志和 crash dump 落在两套路径里。
    setDataBaseDir(dataBaseDir);
  }
  return dataBaseDir;
}

/** Dev 数据根：显式 env 覆盖（E2E / CI），否则固定 `~/.zcode-dev`。 */
export function resolveDevDataBaseDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.ZCODE_DATA_BASE_DIR?.trim() || join(homedir(), DEV_DATA_BASE_DIR_NAME);
}

/** Dev 数据根下 agent CLI 会话库的位置；与 CLI 默认布局 `~/.zcode/cli/db/db.sqlite` 同构。 */
export function resolveDevAgentSessionDbPath(dataBaseDir: string): string {
  return join(dataBaseDir, ".zcode", "cli", "db", "db.sqlite");
}

function applyDevDataBaseDirBootstrap(): string {
  const dataBaseDir = resolveDevDataBaseDir();
  // Agent CLI 的会话库默认锚定真实 HOME（~/.zcode/cli/db/db.sqlite），不随
  // ZCODE_DATA_BASE_DIR 迁移；tasks-index 只是它的同步投影，不注入会让 dev 与
  // 正式版共用任务列表事实源。CLI 的 env-config adapter 认这两个变量。
  process.env.ZCODE_DATA_BASE_DIR = dataBaseDir;
  process.env.ZCODE_SESSION_DB_PATH = resolveDevAgentSessionDbPath(dataBaseDir);
  // 用户级 HOME 锚定目录（AGENTS.md / 用户 skills / 全局 workflows / CLI config.json /
  // mailbox / .claude 集成）的统一契约，App 与 CLI 两侧经 @zcode/shared/user-data-home
  // 同源解析，彻底与正式版 ~/.zcode 隔离；生产不注入、行为不变。
  process.env.ZCODE_USER_HOME = dataBaseDir;
  // storage.dir 是 agent 侧绝大多数数据根的锚点（contracts 默认字面量 `~/.zcode`）：
  // 子 agent 持久记忆（提示词里的 <MEMORY_ROOT> = {storageRoot}/agent-memory/<agent>）、
  // 子 agent profiles/state、image/pdf 缓存、artifacts 都从它派生。env 补丁在合成顺序里
  // 高于用户 config.json，注入后这些路径全部落到 dev 根。
  // 仍按设计锚定真实 HOME、不随 storage.dir 迁移的：全局 workflows（机器级共享）、
  // 用户级 AGENTS.md 与 skills（App/CLI 契约路径），提示词与运行时一致，无路径分叉。
  process.env.ZCODE_STORAGE_DIR = join(dataBaseDir, ".zcode");
  setDataBaseDir(dataBaseDir);
  return dataBaseDir;
}
