import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SOURCE_SERVER_RELEASE_DESCRIPTOR_FILE_NAME,
  ZCODE_VERSION,
  remoteAssetDirsSchema,
  type SourceServerReleaseDescriptor,
} from "@zcode/shared";
// 运行时校验测试直接消费 shared 的 ZCODE_VERSION：工程 Vitest 未注入 __ZCODE_VERSION__ define，
// version.ts 回落到 "0.0.0-dev"。fixture 的 descriptor.version 必须用它构造，硬编码版本号会随根
// package.json bump 而失配（readDescriptor 强校验 version === ZCODE_VERSION）。
import { resolveSourceServerReleaseAsset } from "../src/host/sourceServerReleaseResolver.js";

const TARGETS = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"] as const;
const CDN_BASE = "https://cdn.example.test/releases";

const linuxX64Probe = { platform: "linux", arch: "x64", installed: false };

function archiveContent(target: string): string {
  return `zcode-server-${target}-archive-payload`;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

interface StageReleaseOptions {
  version?: string;
  /** 覆盖 archive sha256，制造内建校验失败场景。 */
  sha256Override?: string;
  /** 只写 archive 不写 descriptor，制造内建 descriptor 缺失场景。 */
  omitDescriptor?: boolean;
}

/**
 * 按 mock-cdn/releases/<version>/ 的同构布局（也是 .app 内 source-server/<version>/ 的布局：
 * descriptor + 4 平台 archive）写一份 release 目录。archive 内容与 descriptor 的
 * sizeBytes/sha256 保持一致，使 resolveLocalDescriptor 的本地校验可命中。
 */
async function stageReleaseDir(root: string, options: StageReleaseOptions = {}): Promise<string> {
  const version = options.version ?? ZCODE_VERSION;
  await mkdir(root, { recursive: true });
  const descriptor: SourceServerReleaseDescriptor = {
    schemaVersion: 1,
    version,
    archives: TARGETS.map((target) => ({
      target,
      version,
      fileName: `zcode-server-${target}.tar.gz`,
      sha256: options.sha256Override ?? sha256(archiveContent(target)),
      sizeBytes: Buffer.byteLength(archiveContent(target), "utf8"),
      // 与 dev 分支一致：descriptor 内返回相对文件名，由调用方按需拼基址。
      urls: [`zcode-server-${target}.tar.gz`],
    })),
  };
  await Promise.all(
    descriptor.archives.map((archive) =>
      writeFile(join(root, archive.fileName), archiveContent(archive.target), "utf8"),
    ),
  );
  if (!options.omitDescriptor) {
    await writeFile(
      join(root, SOURCE_SERVER_RELEASE_DESCRIPTOR_FILE_NAME),
      JSON.stringify(descriptor, null, 2),
      "utf8",
    );
  }
  return root;
}

/** 打包态内建资产测试不允许任何触网：未命中 handler 的请求直接抛错并留下调用记录。 */
function createFetchMock(handler: (url: string) => Response | undefined) {
  return vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const response = handler(url);
    if (!response) {
      throw new Error(`Unexpected network access: ${url}`);
    }
    return response;
  });
}

/** CDN 回退路径上的远端 descriptor：version 必须等于测试进程的 ZCODE_VERSION。 */
function remoteDescriptor(): SourceServerReleaseDescriptor {
  return {
    schemaVersion: 1,
    version: ZCODE_VERSION,
    archives: TARGETS.map((target) => ({
      target,
      version: ZCODE_VERSION,
      fileName: `zcode-server-${target}.tar.gz`,
      sha256: "b".repeat(64),
      sizeBytes: 1024,
      urls: [`${CDN_BASE}/${ZCODE_VERSION}/zcode-server-${target}.tar.gz`],
    })),
  };
}

/** 断言回退路径确实取了远端 descriptor（resolveRemoteDescriptor 走了 CDN 候选）。 */
function cdnDescriptorHandler(url: string): Response | undefined {
  if (!url.includes(SOURCE_SERVER_RELEASE_DESCRIPTOR_FILE_NAME)) return undefined;
  return new Response(JSON.stringify(remoteDescriptor()), { status: 200 });
}

describe("Source Server bundled-release-local resolution", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("returns the bundled archive path without network access when the bundled descriptor hits", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-bundled-release-"));
    roots.push(root);
    const bundledDir = await stageReleaseDir(join(root, "bundled"));
    const fetchMock = createFetchMock(() => undefined);
    const asset = await resolveSourceServerReleaseAsset(
      linuxX64Probe,
      { sourceServerArtifactPolicy: "bundled-release-local", bundledAssetsDir: bundledDir },
      { kind: "ssh", host: "server.example.test", username: "deploy" },
      { fetch: fetchMock as unknown as typeof fetch },
    );
    expect(asset.localArchivePath).toBe(join(bundledDir, "zcode-server-linux-x64.tar.gz"));
    expect(asset.target).toBe("linux-x64");
    expect(asset.version).toBe(ZCODE_VERSION);
    expect(asset.sha256).toBe(sha256(archiveContent("linux-x64")));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      scenario: "descriptor missing",
      stage: () => ({ omitDescriptor: true }),
    },
    {
      scenario: "descriptor version mismatch",
      stage: () => ({ version: "9.9.9-not-installed" }),
    },
    {
      scenario: "archive sha256 mismatch",
      stage: () => ({ sha256Override: "0".repeat(64) }),
    },
  ])(
    "falls back to the CDN descriptor when the bundled release fails because of $scenario",
    async ({ stage }) => {
      const root = await mkdtemp(join(tmpdir(), "zcode-bundled-release-"));
      roots.push(root);
      const bundledDir = await stageReleaseDir(join(root, "bundled"), stage());
      const fetchMock = createFetchMock(cdnDescriptorHandler);
      const asset = await resolveSourceServerReleaseAsset(
        linuxX64Probe,
        {
          sourceServerArtifactPolicy: "bundled-release-local",
          bundledAssetsDir: bundledDir,
          remoteCdnBaseUrls: [CDN_BASE],
        },
        {
          kind: "ssh",
          host: "server.example.test",
          username: "deploy",
          assetInstallMode: "remote-download",
        },
        { fetch: fetchMock as unknown as typeof fetch },
      );
      // 内建资产只允许加速、不允许阻断连接：缺失/校验失败必须落入既有 release-versioned 的 CDN 回退。
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
        SOURCE_SERVER_RELEASE_DESCRIPTOR_FILE_NAME,
      );
      expect(asset.localArchivePath).toBeUndefined();
      expect(asset.version).toBe(ZCODE_VERSION);
      expect(asset.urls).toContain(`${CDN_BASE}/${ZCODE_VERSION}/zcode-server-linux-x64.tar.gz`);
    },
  );

  it("keeps local upload for ssh remote-download profiles when bundled assets hit (override semantics)", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-bundled-release-"));
    roots.push(root);
    const bundledDir = await stageReleaseDir(join(root, "bundled"));
    const fetchMock = createFetchMock(() => undefined);
    const asset = await resolveSourceServerReleaseAsset(
      linuxX64Probe,
      {
        sourceServerArtifactPolicy: "bundled-release-local",
        bundledAssetsDir: bundledDir,
        remoteCdnBaseUrls: [CDN_BASE],
      },
      {
        kind: "ssh",
        host: "server.example.test",
        username: "deploy",
        assetInstallMode: "remote-download",
      },
      { fetch: fetchMock as unknown as typeof fetch },
    );
    // bundled 命中优先于 ssh Profile 的 remote-download 偏好：需求决定的行为覆盖（本地直传）。
    expect(asset.localArchivePath).toBe(join(bundledDir, "zcode-server-linux-x64.tar.gz"));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ignores bundledAssetsDir when the policy is release-versioned", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-bundled-release-"));
    roots.push(root);
    const bundledDir = await stageReleaseDir(join(root, "bundled"));
    const fetchMock = createFetchMock(cdnDescriptorHandler);
    const asset = await resolveSourceServerReleaseAsset(
      linuxX64Probe,
      {
        sourceServerArtifactPolicy: "release-versioned",
        bundledAssetsDir: bundledDir,
        remoteCdnBaseUrls: [CDN_BASE],
      },
      {
        kind: "ssh",
        host: "server.example.test",
        username: "deploy",
        assetInstallMode: "remote-download",
      },
      { fetch: fetchMock as unknown as typeof fetch },
    );
    // 防御语义：策略不是 bundled-release-local 时，内建目录不得被消费。
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(asset.localArchivePath).toBeUndefined();
    expect(asset.urls).toContain(`${CDN_BASE}/${ZCODE_VERSION}/zcode-server-linux-x64.tar.gz`);
  });
});

describe("Source Server development-content-addressed regression", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("still resolves the mock-cdn local archive without network access", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-dev-release-"));
    roots.push(root);
    const releaseDir = await stageReleaseDir(join(root, "releases", ZCODE_VERSION));
    const fetchMock = createFetchMock(() => undefined);
    const asset = await resolveSourceServerReleaseAsset(
      linuxX64Probe,
      { sourceServerArtifactPolicy: "development-content-addressed", mockCdnDir: root },
      { kind: "ssh", host: "server.example.test", username: "deploy" },
      { fetch: fetchMock as unknown as typeof fetch },
    );
    expect(asset.localArchivePath).toBe(join(releaseDir, "zcode-server-linux-x64.tar.gz"));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still fails explicitly when the dev release descriptor is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-dev-release-"));
    roots.push(root);
    await mkdir(root, { recursive: true });
    const fetchMock = createFetchMock(() => undefined);
    await expect(
      resolveSourceServerReleaseAsset(
        linuxX64Probe,
        { sourceServerArtifactPolicy: "development-content-addressed", mockCdnDir: root },
        { kind: "ssh", host: "server.example.test", username: "deploy" },
        { fetch: fetchMock as unknown as typeof fetch },
      ),
    ).rejects.toThrow("run pnpm bootstrap:with-remote");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still fails explicitly when mockCdnDir is absent", async () => {
    const fetchMock = createFetchMock(() => undefined);
    await expect(
      resolveSourceServerReleaseAsset(
        linuxX64Probe,
        { sourceServerArtifactPolicy: "development-content-addressed" },
        { kind: "ssh", host: "server.example.test", username: "deploy" },
        { fetch: fetchMock as unknown as typeof fetch },
      ),
    ).rejects.toThrow("run pnpm bootstrap:with-remote");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("remoteAssetDirsSchema runtime validation", () => {
  it("accepts bundledAssetsDir with the bundled-release-local policy", () => {
    const bundledAssetsDir = "/Applications/ZCode.app/Contents/Resources/source-server/0.0.0-dev";
    const parsed = remoteAssetDirsSchema.safeParse({
      bundledAssetsDir,
      sourceServerArtifactPolicy: "bundled-release-local",
      remoteCdnBaseUrl: CDN_BASE,
      remoteCdnBaseUrls: [CDN_BASE],
      remoteCacheDir: "/tmp/remote-assets-cache",
    });
    // Host 侧 InitLocal/ConnectRemoteWorkspace 走 safeParse 强校验：字段或策略值不被接受时，
    // Main 下发的 bundledAssetsDir 会被剥离，打包态静默退化为 CDN 回退。
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.bundledAssetsDir).toBe(bundledAssetsDir);
      expect(parsed.data.sourceServerArtifactPolicy).toBe("bundled-release-local");
    }
  });

  it("rejects unknown sourceServerArtifactPolicy values", () => {
    expect(
      remoteAssetDirsSchema.safeParse({ sourceServerArtifactPolicy: "not-a-real-policy" }).success,
    ).toBe(false);
  });
});
