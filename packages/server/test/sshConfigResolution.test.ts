import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  expandIdentityFilePath,
  expandProxyCommand,
  isPrivateKeyEncrypted,
  parseProxyJumpEntries,
  parseSshGEffectiveConfig,
  readUsablePrivateKey,
  resolveSshConnectPlan,
} from "../src/remote/sshConfigResolution.js";

const tempDirs: string[] = [];
afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-ssh-resolution-"));
  tempDirs.push(dir);
  return dir;
}

describe("parseSshGEffectiveConfig", () => {
  it("解析 hostname/port/user 与多条 identityfile", () => {
    const output = [
      "user deploy",
      "hostname jump.example.com",
      "port 2222",
      "identityfile ~/.ssh/id_ed25519",
      "identityfile ~/.ssh/id_rsa",
    ].join("\n");
    expect(parseSshGEffectiveConfig(output)).toEqual({
      hostname: "jump.example.com",
      port: 2222,
      user: "deploy",
      identityFiles: ["~/.ssh/id_ed25519", "~/.ssh/id_rsa"],
    });
  });

  it("未配置代理时不产出 proxy 字段（新旧 OpenSSH 均不输出该行）", () => {
    const output = "user hailan\nhostname github.com\nport 22\n";
    const parsed = parseSshGEffectiveConfig(output);
    expect(parsed.proxyJump).toBeUndefined();
    expect(parsed.proxyCommand).toBeUndefined();
  });

  it("显式 none 的代理指令归一为未设置", () => {
    const output = "hostname h\nproxyjump none\nproxycommand none\n";
    const parsed = parseSshGEffectiveConfig(output);
    expect(parsed.proxyJump).toBeUndefined();
    expect(parsed.proxyCommand).toBeUndefined();
  });

  it("保留配置的代理指令原文", () => {
    const output = "hostname h\nproxyjump user@hop1:2222,hop2\nproxycommand nc %h %p\n";
    const parsed = parseSshGEffectiveConfig(output);
    expect(parsed.proxyJump).toBe("user@hop1:2222,hop2");
    expect(parsed.proxyCommand).toBe("nc %h %p");
  });

  it("非法端口忽略，保留首个有效值", () => {
    const output = "port notaport\nport 2200\n";
    expect(parseSshGEffectiveConfig(output).port).toBe(2200);
  });
});

describe("parseProxyJumpEntries", () => {
  it("解析逗号分隔的 user@host:port 链", () => {
    expect(parseProxyJumpEntries("ops@10.0.0.1:2222, hop2.corp")).toEqual([
      { user: "ops", host: "10.0.0.1", port: 2222 },
      { user: undefined, host: "hop2.corp", port: undefined },
    ]);
  });

  it("解析 IPv6 [::1]:2222 与裸 IPv6 地址", () => {
    expect(parseProxyJumpEntries("[::1]:2222")).toEqual([
      { user: undefined, host: "::1", port: 2222 },
    ]);
    expect(parseProxyJumpEntries("fe80::1")).toEqual([
      { user: undefined, host: "fe80::1", port: undefined },
    ]);
  });

  it("空条目与非法端口报错", () => {
    expect(() => parseProxyJumpEntries("")).toThrow("ProxyJump");
    expect(() => parseProxyJumpEntries("host:notaport")).toThrow("端口无效");
    expect(() => parseProxyJumpEntries("[::1")).toThrow("ProxyJump");
  });
});

describe("expandProxyCommand", () => {
  it("替换 %h/%p/%r，%% 输出字面量，未知 token 原样保留", () => {
    expect(expandProxyCommand("nc %h %p", { host: "h.local", port: 22, user: "u" })).toBe(
      "nc h.local 22",
    );
    expect(
      expandProxyCommand("corkscrew proxy 3128 %h %p", { host: "h", port: 2222, user: "u" }),
    ).toBe("corkscrew proxy 3128 h 2222");
    expect(expandProxyCommand("ssh %r@%h", { host: "h", port: 22, user: "ops" })).toBe("ssh ops@h");
    expect(expandProxyCommand("echo 100%% %z", { host: "h", port: 22, user: "u" })).toBe(
      "echo 100% %z",
    );
  });
});

describe("expandIdentityFilePath", () => {
  it("展开 ~/ 与裸 ~，其余原样返回", () => {
    expect(expandIdentityFilePath("~/.ssh/id_ed25519")).toBe(
      join(process.env.HOME ?? "", ".ssh/id_ed25519"),
    );
    expect(expandIdentityFilePath("/abs/key")).toBe("/abs/key");
    expect(expandIdentityFilePath("~")).toBe(process.env.HOME ?? "");
  });
});

describe("isPrivateKeyEncrypted", () => {
  it("识别 PEM Proc-Type 加密头", () => {
    const pem = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "Proc-Type: 4,ENCRYPTED",
      "DEK-Info: AES-128-CBC,ABCD",
      "abc",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");
    expect(isPrivateKeyEncrypted(pem)).toBe(true);
  });

  it("识别 OpenSSH 新格式的非 none cipher", () => {
    // openssh-key-v1\0 头 + ciphername "aes256-ctr"（长度 10）。
    const header = Buffer.from("openssh-key-v1\0", "latin1");
    const cipher = Buffer.concat([Buffer.from([0, 0, 0, 10]), Buffer.from("aes256-ctr", "latin1")]);
    const key = `-----BEGIN OPENSSH PRIVATE KEY-----\n${Buffer.concat([header, cipher]).toString("base64")}\n-----END OPENSSH PRIVATE KEY-----`;
    expect(isPrivateKeyEncrypted(key)).toBe(true);
  });

  it("未加密的 OpenSSH 新格式（cipher none）不判为加密", () => {
    const header = Buffer.from("openssh-key-v1\0", "latin1");
    const cipher = Buffer.concat([Buffer.from([0, 0, 0, 4]), Buffer.from("none", "latin1")]);
    const key = `-----BEGIN OPENSSH PRIVATE KEY-----\n${Buffer.concat([header, cipher]).toString("base64")}\n-----END OPENSSH PRIVATE KEY-----`;
    expect(isPrivateKeyEncrypted(key)).toBe(false);
  });

  it("非私钥内容返回 false", () => {
    expect(isPrivateKeyEncrypted("not a key")).toBe(false);
  });
});

describe("readUsablePrivateKey", () => {
  it("按顺序采用第一个可读且未加密的文件；加密钥无口令时跳过", async () => {
    const dir = await createTempDir();
    const encrypted = join(dir, "encrypted.key");
    const plain = join(dir, "plain.key");
    await writeFile(
      encrypted,
      "-----BEGIN OPENSSH PRIVATE KEY-----\ngarbage\n-----END OPENSSH PRIVATE KEY-----",
    );
    await writeFile(
      plain,
      "-----BEGIN OPENSSH PRIVATE KEY-----\nplain\n-----END OPENSSH PRIVATE KEY-----",
    );
    // 上面的 garbage 解析不出 openssh-key-v1 头，按未加密处理会被采用；
    // 用带 Proc-Type 的 PEM 造一个确定加密的文件。
    await writeFile(
      encrypted,
      [
        "-----BEGIN RSA PRIVATE KEY-----",
        "Proc-Type: 4,ENCRYPTED",
        "abc",
        "-----END RSA PRIVATE KEY-----",
      ].join("\n"),
    );
    await expect(readUsablePrivateKey([encrypted, plain])).resolves.toContain("plain");
    await expect(readUsablePrivateKey([encrypted], "passphrase")).resolves.toContain("ENCRYPTED");
  });

  it("所有文件不可读时返回 undefined", async () => {
    await expect(readUsablePrivateKey(["/nonexistent/key"])).resolves.toBeUndefined();
  });
});

describe("resolveSshConnectPlan", () => {
  it("ssh 二进制不可用时回退快照值，不启用代理", async () => {
    const plan = await resolveSshConnectPlan(
      { host: "10.1.1.1", port: 2222, username: "ops" },
      { sshExecutablePath: "definitely-not-ssh-binary-xyz" },
    );
    expect(plan.source).toBe("snapshot");
    expect(plan.target).toEqual({
      host: "10.1.1.1",
      port: 2222,
      username: "ops",
      identityFiles: [],
    });
  });

  it("真实 ssh -G 解析本机默认配置（存在 ssh 时）", async () => {
    // 依赖环境有 ssh：无配置主机 -G 返回 hostname=query、user=当前用户；只验证解析路径不抛错且 host 正确。
    const plan = await resolveSshConnectPlan(
      { host: "zcode-resolution-probe.invalid", username: "ops" },
      { sshExecutablePath: "/usr/bin/ssh" },
    );
    if (plan.source === "snapshot") {
      return;
    }
    expect(plan.target.host).toBe("zcode-resolution-probe.invalid");
    expect(plan.target.username).toBe("ops");
  });
});
