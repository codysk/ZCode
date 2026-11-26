/**
 * Node-only shared utilities: 用户级数据 HOME 锚点。
 *
 * This subpath must not be imported by renderer/browser bundles.
 */
import { homedir } from "node:os";

export const ZCODE_USER_HOME_ENV = "ZCODE_USER_HOME";

/**
 * 用户级 HOME 锚定目录（`~/.zcode/**`、`~/.claude/**` 等）的解析。
 *
 * 优先级：`ZCODE_USER_HOME` > `HOME` > `USERPROFILE` > `os.homedir()`。
 *
 * Dev 构建注入 `ZCODE_USER_HOME` 使 AGENTS.md、用户级 skills、全局 workflows、
 * CLI config.json、mailbox、`.claude` 等全部落到 dev 数据根，与正式版彻底隔离；
 * 本 fork 的打包构建同样注入（数据根固定 `~/.zcode-fork`，契约见
 * docs/development-mise-runtime.md「打包版数据隔离」）；原版生产不设置该变量，
 * 行为与历史语义完全一致。
 * App 侧（packages/services）与 CLI 侧（adapters）必须经此同一入口解析，
 * 否则 App 写的文件与 Agent 读的文件会分叉。
 */
export function resolveUserDataHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[ZCODE_USER_HOME_ENV]?.trim();
  if (override) {
    return override;
  }
  const envHome = env.HOME?.trim() || env.USERPROFILE?.trim();
  return envHome && envHome.length > 0 ? envHome : homedir();
}
