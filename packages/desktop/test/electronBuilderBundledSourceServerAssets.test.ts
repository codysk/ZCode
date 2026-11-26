import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getBuildMetadata } from "../scripts/build-metadata.mjs";

const testDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(testDir, "..");

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

function readSource(relativePath) {
  return readFileSync(join(desktopRoot, relativePath), "utf-8");
}

function findSourceServerExtraResource(extraResources, appVersion) {
  return extraResources?.find(
    (entry) =>
      typeof entry?.from === "string" &&
      entry.from === resolve(desktopRoot, "mock-cdn", "releases", appVersion) &&
      entry.to === `source-server/${appVersion}`,
  );
}

describe("electron-builder 随包内建 Source Server release 资产", () => {
  // ① 三平台 extraResources 都必须含 mock-cdn/releases/<version> → source-server/<version> 映射。
  // 映射本身不带平台条件，但按三平台分别加载配置做回归锚点，防止未来被挪进平台分支后被静默丢掉。
  for (const targetOs of ["darwin", "win32", "linux"] as const) {
    it(`${targetOs} extraResources 映射 mock-cdn/releases/<version> 到 source-server/<version>`, async () => {
      vi.stubEnv("ZCODE_TARGET_OS", targetOs);
      const { default: config } = await import("../electron-builder.config.js");
      const { appVersion } = getBuildMetadata();

      const entry = findSourceServerExtraResource(
        config.extraResources,
        appVersion,
      );
      expect(entry).toBeDefined();
      // 只收 descriptor 与 tar.gz，不带 staging 目录里的其他文件。
      expect(entry.filter).toEqual(["source-server-release.json", "*.tar.gz"]);
    });
  }

  it("afterPack 注册了 source-server 资产存在性断言（extraResources 缺源时 electron-builder 会静默跳过）", async () => {
    vi.stubEnv("ZCODE_TARGET_OS", "darwin");
    const { default: config } = await import("../electron-builder.config.js");
    expect(typeof config.afterPack).toBe("function");

    const configSource = readSource("electron-builder.config.js");
    // 钩子序列里必须真正调用断言函数，光有函数定义不构成兜底。
    expect(configSource).toContain(
      "afterPack:assertPackagedSourceServerAssets",
    );
    expect(configSource).toContain(
      "function assertPackagedSourceServerAssets(context)",
    );
  });

  it("prepare 默认链路完成 staging：localRuntimeScripts 与 desktop scripts 都含 prepare:source-server-assets", () => {
    const prepareRuntimeAssetsSource = readSource(
      "scripts/prepare-runtime-assets.mjs",
    );
    expect(prepareRuntimeAssetsSource).toContain(
      '"prepare:source-server-assets"',
    );

    const desktopPackageJson = JSON.parse(readSource("package.json"));
    // build = prepare:runtime-assets && build:no-runtime-assets；bundle 默认链路先跑
    // prepare:runtime-assets 再 build，两入口都依赖该 script 完成 staging。
    // --skip-agent-build 必须保留：stage:remote-assets 首个 target 会经
    // build-desktop-agent-cli.mjs 重跑 stageAgentBundle，rmSync 清空
    // bundled-agents/<platform>/glm，抹掉 prepare:agent-bundle 已 stage 的官方插件与
    // koffi/sharp native 资产，导致 afterPack assertPackagedCuaKoffi 失败（bundle 退出码 1）。
    // agent bundle 由同一链路的 prepare:agent-bundle（首项）真实构建，复用即安全。
    expect(desktopPackageJson.scripts["prepare:source-server-assets"]).toBe(
      "pnpm --filter @zcode/server-cli run stage:remote-assets --skip-agent-build",
    );
    expect(desktopPackageJson.scripts["prepare:runtime-assets"]).toBe(
      "node scripts/prepare-runtime-assets.mjs",
    );
  });

  it("audit-bundle-size 限额覆盖随包内建 Source Server 资产（500 基线 + ~357MiB 资产）", () => {
    const auditSource = readSource("scripts/audit-bundle-size.mjs");
    const limitsBlock = auditSource.slice(
      auditSource.indexOf("const limitsMb = {"),
      auditSource.indexOf("};", auditSource.indexOf("const limitsMb = {")),
    );
    expect(limitsBlock).not.toBe("");

    const entries = [
      ...limitsBlock.matchAll(/"?\.(?:dmg|zip|exe|appimage|deb)"?:\s*(\d+)/g),
    ];
    expect(entries.length).toBe(5);
    for (const [, value] of entries) {
      // 内建 4 平台 release 资产约 357MiB（du 实测 mock-cdn/releases/4.0.0），限额必须覆盖基线 + 资产。
      expect(Number(value)).toBeGreaterThanOrEqual(500 + 357);
    }

    const defaultEntry = limitsBlock.match(/default:\s*(\d+)/);
    expect(defaultEntry).not.toBeNull();
    expect(Number(defaultEntry[1])).toBeGreaterThanOrEqual(500 + 357);
  });
});
