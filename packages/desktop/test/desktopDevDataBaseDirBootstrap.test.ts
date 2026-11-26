import { existsSync, readFileSync } from "node:fs";
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
  FORK_DATA_BASE_DIR_NAME,
  applyEarlyDataBaseDirBootstrap,
  resolveBootstrapSettingsFile,
  resolveDevAgentSessionDbPath,
  resolveDevDataBaseDir,
  resolveForkDataBaseDir,
} from "../src/main/desktopDataBaseDirBootstrap.js";

const ENV_KEYS = [
  "ZCODE_DATA_BASE_DIR",
  "ZCODE_SESSION_DB_PATH",
  "ZCODE_STORAGE_DIR",
  "ZCODE_USER_HOME",
  "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE",
  "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE",
  "ZCODE_OFFICIAL_ENDPOINT",
  "ZCODE_OFFICIAL_ENDPOINT_TOKEN",
  "ZCODE_SESSION_ID",
  "ZCODE_PROJECT_DIR",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_SESSION_ID",
  "CLAUDE_PROJECT_DIR",
  "ZCODE_CREDENTIAL_SECRET",
  "ZCODE_OFFPEAK_MOCK",
  "ZCODE_DESKTOP_HOME_DIR",
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

  it("已打包（fork 版）：数据根固定 ~/.zcode-fork 并完成四注入，不再读 ~/.zcode", () => {
    isPackagedRef.value = true;
    const dir = applyEarlyDataBaseDirBootstrap();
    const expected = `${process.env.HOME}/${FORK_DATA_BASE_DIR_NAME}`;
    expect(dir).toBe(expected);
    expect(setDataBaseDirSpy).toHaveBeenCalledWith(expected);
    expect(process.env.ZCODE_DATA_BASE_DIR).toBe(expected);
    expect(process.env.ZCODE_SESSION_DB_PATH).toBe(`${expected}/.zcode/cli/db/db.sqlite`);
    expect(process.env.ZCODE_STORAGE_DIR).toBe(`${expected}/.zcode`);
    expect(process.env.ZCODE_USER_HOME).toBe(expected);
    // setting.json 引导读取锚定 fork 根，不得指向原版 ~/.zcode
    expect(resolveBootstrapSettingsFile()).toBe(`${expected}/.zcode/v2/setting.json`);
  });

  it("已打包（fork 版）：fork 根 setting.json 的 dataBaseDir 引导优先于默认根", () => {
    isPackagedRef.value = true;
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ dataBaseDir: "/tmp/fork-custom-root" }));
    const dir = applyEarlyDataBaseDirBootstrap();
    expect(dir).toBe("/tmp/fork-custom-root");
    expect(setDataBaseDirSpy).toHaveBeenCalledWith("/tmp/fork-custom-root");
    expect(process.env.ZCODE_DATA_BASE_DIR).toBe("/tmp/fork-custom-root");
    expect(process.env.ZCODE_USER_HOME).toBe("/tmp/fork-custom-root");
    // 引导读取发生在 fork 根的 setting.json，不在原版 ~/.zcode
    expect(vi.mocked(existsSync)).toHaveBeenCalledWith(
      `${process.env.HOME}/${FORK_DATA_BASE_DIR_NAME}/.zcode/v2/setting.json`,
    );
  });

  it("已打包（fork 版）：显式 ZCODE_DATA_BASE_DIR 优先于 setting.json 引导（E2E 隔离 home）", () => {
    isPackagedRef.value = true;
    process.env.ZCODE_DATA_BASE_DIR = "/tmp/zcode-e2e-home";
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ dataBaseDir: "/tmp/fork-custom-root" }));
    const dir = applyEarlyDataBaseDirBootstrap();
    expect(dir).toBe("/tmp/zcode-e2e-home");
    expect(setDataBaseDirSpy).toHaveBeenCalledWith("/tmp/zcode-e2e-home");
    expect(process.env.ZCODE_SESSION_DB_PATH).toBe("/tmp/zcode-e2e-home/.zcode/cli/db/db.sqlite");
  });

  it("resolveDevDataBaseDir / resolveForkDataBaseDir / 会话库路径纯解析", () => {
    expect(resolveDevDataBaseDir({})).toBe(`${process.env.HOME}/${DEV_DATA_BASE_DIR_NAME}`);
    expect(resolveDevDataBaseDir({ ZCODE_DATA_BASE_DIR: " /tmp/x " })).toBe("/tmp/x");
    expect(resolveForkDataBaseDir({})).toBe(`${process.env.HOME}/${FORK_DATA_BASE_DIR_NAME}`);
    expect(resolveForkDataBaseDir({ ZCODE_DATA_BASE_DIR: " /tmp/y " })).toBe("/tmp/y");
    expect(resolveDevAgentSessionDbPath("/d")).toBe("/d/.zcode/cli/db/db.sqlite");
  });

  it("清洗继承的其他 ZCode 实例运行态：指向原版 ~/.zcode 的路径与实例凭据一律删除", () => {
    const originalRoot = `${process.env.HOME}/.zcode`;
    process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = `${originalRoot}/v2/runtime/provider/x/zcode-builtin.json`;
    process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = `${originalRoot}/v2/provider_config.json`;
    process.env.ZCODE_OFFICIAL_ENDPOINT = "https://official.example.test";
    process.env.ZCODE_OFFICIAL_ENDPOINT_TOKEN = "official-token";
    process.env.ZCODE_SESSION_ID = "sess_official";
    process.env.CLAUDE_SESSION_ID = "sess_official";
    // E2E 场景：provider 配置指向仓库路径（非 ~/.zcode）、ZCODE_DESKTOP_* 覆盖、显式数据根 —— 必须保留
    process.env.ZCODE_CREDENTIAL_SECRET = "e2e-secret";
    process.env.ZCODE_OFFPEAK_MOCK = "1";
    const dir = applyEarlyDataBaseDirBootstrap();
    expect(dir).toBe(`${process.env.HOME}/${DEV_DATA_BASE_DIR_NAME}`);
    expect(process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE).toBeUndefined();
    expect(process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE).toBeUndefined();
    expect(process.env.ZCODE_OFFICIAL_ENDPOINT).toBeUndefined();
    expect(process.env.ZCODE_OFFICIAL_ENDPOINT_TOKEN).toBeUndefined();
    expect(process.env.ZCODE_SESSION_ID).toBeUndefined();
    expect(process.env.CLAUDE_SESSION_ID).toBeUndefined();
    expect(process.env.ZCODE_CREDENTIAL_SECRET).toBe("e2e-secret");
    expect(process.env.ZCODE_OFFPEAK_MOCK).toBe("1");
  });

  it("清洗保留 E2E 的仓库路径 provider 配置与 ZCODE_DESKTOP_*/ZCODE_DATA_BASE_DIR 覆盖", () => {
    process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = "/repo/config/provider/zcode-builtin.json";
    process.env.ZCODE_DESKTOP_HOME_DIR = "/tmp/e2e-home-dir";
    process.env.ZCODE_DATA_BASE_DIR = "/tmp/zcode-e2e-home";
    const dir = applyEarlyDataBaseDirBootstrap();
    expect(process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE).toBe("/repo/config/provider/zcode-builtin.json");
    expect(process.env.ZCODE_DESKTOP_HOME_DIR).toBe("/tmp/e2e-home-dir");
    expect(dir).toBe("/tmp/zcode-e2e-home");
  });
});
