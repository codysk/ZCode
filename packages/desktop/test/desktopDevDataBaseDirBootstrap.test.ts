import { existsSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const isPackagedRef = { value: true };
const setDataBaseDirSpy = vi.fn();

vi.mock("../src/main/desktopElectronApp.js", () => ({
  isElectronAppPackaged: () => isPackagedRef.value,
}));

vi.mock("@zcode/services/node", () => ({
  setDataBaseDir: (...args: unknown[]) => setDataBaseDirSpy(...args),
}));

// 仅 mock setting.json 读取相关的 fs 入口，避免依赖真实 HOME 的文件状态。
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => "{}"),
  };
});

import {
  DEV_DATA_BASE_DIR_NAME,
  applyEarlyDataBaseDirBootstrap,
  resolveDevAgentSessionDbPath,
  resolveDevDataBaseDir,
} from "../src/main/desktopDataBaseDirBootstrap.js";

const ENV_KEYS = [
  "ZCODE_DATA_BASE_DIR",
  "ZCODE_SESSION_DB_PATH",
  "ZCODE_STORAGE_DIR",
  "ZCODE_USER_HOME",
] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  isPackagedRef.value = false;
  setDataBaseDirSpy.mockClear();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.mocked(existsSync).mockClear();
});

describe("dev 构建数据根固定到 ~/.zcode-dev（desktopDataBaseDirBootstrap）", () => {
  it("未打包且无显式 env：固定 ~/.zcode-dev 并注入 agent 会话库与 storage 根", () => {
    const dir = applyEarlyDataBaseDirBootstrap();
    const expected = `${process.env.HOME}/${DEV_DATA_BASE_DIR_NAME}`;
    expect(dir).toBe(expected);
    expect(setDataBaseDirSpy).toHaveBeenCalledWith(expected);
    expect(process.env.ZCODE_DATA_BASE_DIR).toBe(expected);
    expect(process.env.ZCODE_SESSION_DB_PATH).toBe(`${expected}/.zcode/cli/db/db.sqlite`);
    // storage.dir 驱动子 agent 持久记忆（<MEMORY_ROOT>）、profiles 与缓存等派生路径
    expect(process.env.ZCODE_STORAGE_DIR).toBe(`${expected}/.zcode`);
    // ZCODE_USER_HOME 是 App/CLI 两侧用户级 HOME 锚定路径（AGENTS.md/skills/workflows/
    // config.json/mailbox/.claude 集成）的统一契约，彻底隔离 ~/.zcode
    expect(process.env.ZCODE_USER_HOME).toBe(expected);
  });

  it("未打包但显式设置 ZCODE_DATA_BASE_DIR：显式值优先（E2E 隔离 home 场景）", () => {
    process.env.ZCODE_DATA_BASE_DIR = "/tmp/zcode-e2e-home";
    const dir = applyEarlyDataBaseDirBootstrap();
    expect(dir).toBe("/tmp/zcode-e2e-home");
    expect(process.env.ZCODE_SESSION_DB_PATH).toBe("/tmp/zcode-e2e-home/.zcode/cli/db/db.sqlite");
    expect(setDataBaseDirSpy).toHaveBeenCalledWith("/tmp/zcode-e2e-home");
  });

  it("已打包（正式版）：不进入 dev 隔离，保持 setting.json 引导语义", () => {
    isPackagedRef.value = true;
    const dir = applyEarlyDataBaseDirBootstrap();
    // 测试 mock 下 setting.json 不存在 → 无自定义目录、不注入
    expect(dir).toBeNull();
    expect(setDataBaseDirSpy).not.toHaveBeenCalled();
    expect(process.env.ZCODE_DATA_BASE_DIR).toBeUndefined();
    expect(process.env.ZCODE_SESSION_DB_PATH).toBeUndefined();
  });

  it("resolveDevDataBaseDir / resolveDevAgentSessionDbPath 纯解析", () => {
    expect(resolveDevDataBaseDir({})).toBe(`${process.env.HOME}/${DEV_DATA_BASE_DIR_NAME}`);
    expect(resolveDevDataBaseDir({ ZCODE_DATA_BASE_DIR: " /tmp/x " })).toBe("/tmp/x");
    expect(resolveDevAgentSessionDbPath("/d")).toBe("/d/.zcode/cli/db/db.sqlite");
  });
});
