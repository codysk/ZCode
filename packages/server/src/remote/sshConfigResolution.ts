/* ssh config 有效配置解析集中维护：-G 运行、输出解析、跳板链展开与 token 替换共享同一套类型与语义。 */
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

/** 跳板链递归深度上限；与常见多层堡垒机场景相比足够宽，同时防止 config 自引用拖死连接。 */
const MAX_PROXY_JUMP_DEPTH = 8;
/** 单次 `ssh -G` 查询超时。连接期只查一次目标（跳板逐跳各查一次），超时后按回退语义处理。 */
const SSH_G_CONNECT_TIMEOUT_MS = 5_000;

export interface SshConnectionNode {
  host: string;
  port: number;
  username: string;
  /** `-G` 解析出的 identityfile（已完成 ~ 展开，按 ssh 尝试顺序）。 */
  identityFiles: string[];
  /** 连接本节点前需要先建立的底层传输；undefined 表示 ssh2 自行发起 TCP。 */
  via?: SshVia;
}

export type SshVia =
  | { kind: "command"; command: string; targetHost: string; targetPort: number }
  | { kind: "jump"; chain: SshConnectionNode[] };

export interface SshConnectPlan {
  target: SshConnectionNode;
  /** config（-G 成功）或 snapshot（回退快照值，不启用代理）。 */
  source: "ssh-config" | "snapshot";
}

export interface SshConnectPlanInput {
  host: string;
  port?: number;
  username: string;
  sshConfigAlias?: string;
  privateKeyPath?: string;
}

export interface SshConfigResolutionContext {
  /** ssh 可执行文件路径；调用方探测一次传入，保持整条链路使用同一二进制。 */
  sshExecutablePath: string;
}

/** `-G` 输出的有效配置（已按 ssh 语义归一）。 */
export interface ParsedSshGConfig {
  hostname?: string;
  port?: number;
  user?: string;
  identityFiles: string[];
  proxyJump?: string;
  proxyCommand?: string;
}

/**
 * 解析 `ssh -G <alias|host>` 的输出。
 * 无代理时新旧 OpenSSH 都不输出 proxyjump/proxycommand 行；显式 `none` 也归一为未设置。
 */
export function parseSshGEffectiveConfig(output: string): ParsedSshGConfig {
  const parsed: ParsedSshGConfig = { identityFiles: [] };
  for (const line of output.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const match = /^(\S+)\s+(.*)$/u.exec(trimmed);
    if (!match?.[1] || match[2] == null) {
      continue;
    }
    const key = match[1].toLowerCase();
    const value = match[2].trim();
    switch (key) {
      case "hostname":
        if (!parsed.hostname && value.length > 0) {
          parsed.hostname = value;
        }
        break;
      case "port": {
        const port = toValidPort(value);
        if (parsed.port == null && port != null) {
          parsed.port = port;
        }
        break;
      }
      case "user":
        if (!parsed.user && value.length > 0) {
          parsed.user = value;
        }
        break;
      case "identityfile":
        if (value.length > 0) {
          parsed.identityFiles.push(value);
        }
        break;
      case "proxyjump":
        if (parsed.proxyJump == null && value.length > 0 && value.toLowerCase() !== "none") {
          parsed.proxyJump = value;
        }
        break;
      case "proxycommand":
        if (parsed.proxyCommand == null && value.length > 0 && value.toLowerCase() !== "none") {
          parsed.proxyCommand = value;
        }
        break;
      default:
        break;
    }
  }
  return parsed;
}

/** 展开 ProxyJump 配置值为 `[user@]host[:port]` 条目；支持逗号分隔与 IPv6 `[::1]:22`。 */
export function parseProxyJumpEntries(
  value: string,
): Array<{ user?: string; host: string; port?: number }> {
  const entries: Array<{ user?: string; host: string; port?: number }> = [];
  for (const rawEntry of value.split(",")) {
    const entry = rawEntry.trim();
    if (!entry) {
      continue;
    }
    let rest = entry;
    let user: string | undefined;
    // user@ 只按最后一个 @ 切分：IPv6 字面量不含 @，这里不会误切。
    const atIndex = rest.lastIndexOf("@");
    if (atIndex > 0) {
      user = rest.slice(0, atIndex);
      rest = rest.slice(atIndex + 1);
    }
    if (!rest) {
      throw new Error(`ProxyJump 条目无效：${entry}`);
    }
    let host: string;
    let port: number | undefined;
    if (rest.startsWith("[")) {
      // IPv6：[::1]:22
      const closeIndex = rest.indexOf("]");
      if (closeIndex < 0) {
        throw new Error(`ProxyJump 条目无效：${entry}`);
      }
      host = rest.slice(1, closeIndex);
      const portPart = rest.slice(closeIndex + 1);
      if (portPart.startsWith(":")) {
        port = toValidPort(portPart.slice(1));
        if (port == null) {
          throw new Error(`ProxyJump 条目端口无效：${entry}`);
        }
      } else if (portPart.length > 0) {
        throw new Error(`ProxyJump 条目无效：${entry}`);
      }
    } else {
      // host:port；裸 IPv6 不带端口时冒号计数 > 1 属于合法地址，不能当端口分隔。
      const colonCount = (rest.match(/:/g) ?? []).length;
      if (colonCount === 1) {
        const colonIndex = rest.indexOf(":");
        host = rest.slice(0, colonIndex);
        port = toValidPort(rest.slice(colonIndex + 1));
        if (port == null) {
          throw new Error(`ProxyJump 条目端口无效：${entry}`);
        }
      } else {
        host = rest;
      }
    }
    if (!host) {
      throw new Error(`ProxyJump 条目无效：${entry}`);
    }
    entries.push({ user, host, port });
  }
  if (entries.length === 0) {
    throw new Error("ProxyJump 配置为空");
  }
  return entries;
}

/** ProxyCommand 的 OpenSSH token 替换：%h 目标主机、%p 端口、%r 远端用户、%% 字面量。 */
export function expandProxyCommand(
  command: string,
  params: { host: string; port: number; user: string },
): string {
  let result = "";
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];
    if (char !== "%") {
      result += char;
      continue;
    }
    const next = command[i + 1];
    switch (next) {
      case "h":
        result += params.host;
        i += 1;
        break;
      case "p":
        result += String(params.port);
        i += 1;
        break;
      case "r":
        result += params.user;
        i += 1;
        break;
      case "%":
        result += "%";
        i += 1;
        break;
      default:
        // 未知 token 原样保留，交给用户的 shell 处理，避免误吞配置。
        result += char;
        break;
    }
  }
  return result;
}

/** 展开 identityfile 的 `~/` 与裸 `~` 前缀到当前用户 home；其余路径原样返回。 */
export function expandIdentityFilePath(path: string): string {
  if (path === "~") {
    return homedir();
  }
  if (path.startsWith("~/")) {
    return join(homedir(), path.slice(2));
  }
  return path;
}

/** 运行 `ssh -G`（不带 -F，走 ssh 默认配置解析顺序）；失败或超时返回 null。 */
export async function runSshGQuery(params: {
  sshExecutablePath: string;
  query: string;
  timeoutMs?: number;
}): Promise<string | null> {
  const { sshExecutablePath, query, timeoutMs = SSH_G_CONNECT_TIMEOUT_MS } = params;
  return await new Promise((resolvePromise) => {
    let finished = false;
    let stdout = "";
    const child = spawn(sshExecutablePath, ["-G", "-o", "BatchMode=yes", query], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      // 与 UI 列表查询一致：屏蔽 askpass，保证 -G 是纯本地解析，不会弹出任何交互。
      env: {
        ...process.env,
        SSH_ASKPASS_REQUIRE: "never",
        SSH_ASKPASS: "",
        DISPLAY: "",
      },
    });
    const finish = (result: string | null) => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timeoutId);
      resolvePromise(result);
    };
    const timeoutId = setTimeout(() => {
      child.kill();
      finish(null);
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer | string) => {
      if (finished) {
        return;
      }
      stdout += chunk.toString();
      if (stdout.length > 256_000) {
        stdout = stdout.slice(0, 256_000);
      }
    });
    child.stderr.on("data", () => undefined);
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code === 0 ? stdout : null));
  });
}

function toValidPort(rawPort: string): number | undefined {
  if (!/^\d+$/u.test(rawPort)) {
    return undefined;
  }
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return undefined;
  }
  return port;
}

/**
 * 生成连接计划：
 * - 带 alias 时 -G 结果权威（host/port/user/identityfile/代理）；
 * - 裸 host 时保留快照连接参数，仅采纳代理指令；identityfile 仅在未显式提供 privateKeyPath 时采用。
 * -G 不可用（无 ssh 二进制 / 查询失败）时整体回退快照值，不启用代理。
 */
export async function resolveSshConnectPlan(
  input: SshConnectPlanInput,
  context: SshConfigResolutionContext,
): Promise<SshConnectPlan> {
  const alias = input.sshConfigAlias?.trim();
  const output = await runSshGQuery({
    sshExecutablePath: context.sshExecutablePath,
    query: alias || input.host,
  });
  if (!output) {
    return { source: "snapshot", target: snapshotNode(input) };
  }

  const parsed = parseSshGEffectiveConfig(output);
  if (parsed.proxyJump && parsed.proxyCommand) {
    throw new Error(
      "ssh config 同时配置了 ProxyJump 与 ProxyCommand（OpenSSH 互斥），请修改 ~/.ssh/config 后重试",
    );
  }

  const configUsername = parsed.user?.trim() || localFallbackUsername();
  const resolveNodeFromParsed = (
    nodeParsed: ParsedSshGConfig,
    fallbackHost: string,
  ): SshConnectionNode => ({
    host: nodeParsed.hostname?.trim() || fallbackHost,
    port: nodeParsed.port ?? 22,
    username: nodeParsed.user?.trim() || configUsername || input.username,
    identityFiles: nodeParsed.identityFiles.map(expandIdentityFilePath),
  });

  const targetNode = resolveNodeFromParsed(parsed, alias || input.host);
  if (alias) {
    // alias 模式下 -G 结果权威，覆盖快照 port；user 缺失时保留快照 username 更贴近弹窗语义。
    if (!parsed.user?.trim()) {
      targetNode.username = input.username;
    }
    if (parsed.port == null && input.port != null) {
      targetNode.port = input.port;
    }
  } else {
    // 裸 host：显式输入优先（对齐 ssh -p / -l 语义），但连接主机名必须用 -G 解析结果。
    // 原因：input.host 可能是 config 里的 Host 别名；ssh2 不读 ssh config，本机
    // getaddrinfo 与跳板机的 forwardOut 都无法按别名做 DNS 解析（getaddrinfo ENOTFOUND
    // 的根因）；OpenSSH 语义本来就是 HostName 替换连接目标，显式输入只覆盖端口与用户。
    targetNode.host = parsed.hostname?.trim() || input.host;
    targetNode.port = input.port ?? parsed.port ?? 22;
    targetNode.username = input.username;
    if (input.privateKeyPath?.trim()) {
      targetNode.identityFiles = [];
    }
  }

  const via = await resolveVia(parsed, targetNode, context, new Set<string>(), 0);
  return { source: "ssh-config", target: { ...targetNode, via } };
}

function snapshotNode(input: SshConnectPlanInput): SshConnectionNode {
  return {
    host: input.host,
    port: input.port ?? 22,
    username: input.username,
    // 快照模式下 identityfile 由调用方（create-backend）读取的 privateKey 提供，不在此展开。
    identityFiles: [],
  };
}

function localFallbackUsername(): string {
  try {
    return userInfo().username;
  } catch {
    return "";
  }
}

/**
 * 判断私钥内容是否为加密私钥。
 * 原因：ssh2 对“加密私钥 + 未提供口令”会硬失败（无法像 ssh CLI 一样回落到下一认证方式），
 * config 的默认 identityfile（~/.ssh/id_* 等）会被 -G 一并列出，密码登录的主机若直接采用
 * 会被拖死在密钥阶段。这里在采用前过滤，密码/agent 认证才有机会执行。
 */
export function isPrivateKeyEncrypted(content: string): boolean {
  if (!content.includes("PRIVATE KEY-----")) {
    return false;
  }
  if (/Proc-Type:\s*4,ENCRYPTED/iu.test(content)) {
    return true;
  }
  const body = content
    .split(/\r?\n/u)
    .filter((line) => line.length > 0 && !line.startsWith("-----") && !line.includes(":"))
    .join("");
  try {
    const decoded = Buffer.from(body, "base64");
    if (decoded.subarray(0, 15).toString("latin1") === "openssh-key-v1\0") {
      let offset = 15;
      const nameLength = decoded.readUInt32BE(offset);
      offset += 4;
      const cipherName = decoded.subarray(offset, offset + nameLength).toString("latin1");
      return cipherName !== "none";
    }
  } catch {
    // 解析失败按未加密处理，交由 ssh2 报原始错误。
  }
  return false;
}

/** 依序采用第一个可用 identityfile 的内容：加密钥且未提供口令时跳过该文件。 */
export async function readUsablePrivateKey(
  identityFiles: string[],
  passphrase?: string,
): Promise<string | undefined> {
  for (const identityFile of identityFiles) {
    if (!identityFile) {
      continue;
    }
    let content: string;
    try {
      content = await readFile(identityFile, "utf8");
    } catch {
      // 文件不存在或不可读：按 ssh 语义继续尝试下一个 identityfile。
      continue;
    }
    if (!isPrivateKeyEncrypted(content) || passphrase) {
      return content;
    }
  }
  return undefined;
}

/** 解析一个节点的 via：proxyjump 展开为跳板链（递归），proxycommand 展开为命令。 */
async function resolveVia(
  parsed: ParsedSshGConfig,
  node: SshConnectionNode,
  context: SshConfigResolutionContext,
  seen: Set<string>,
  depth: number,
): Promise<SshVia | undefined> {
  if (parsed.proxyJump) {
    if (depth >= MAX_PROXY_JUMP_DEPTH) {
      throw new Error(`ProxyJump 跳板链嵌套超过 ${MAX_PROXY_JUMP_DEPTH} 层，请检查 ~/.ssh/config`);
    }
    const entries = parseProxyJumpEntries(parsed.proxyJump);
    const chain: SshConnectionNode[] = [];
    for (const entry of entries) {
      const hopKey = `${entry.user ?? ""}@${entry.host}:${entry.port ?? 22}`;
      if (seen.has(hopKey)) {
        throw new Error(`ProxyJump 跳板链存在环：${hopKey}`);
      }
      seen.add(hopKey);
      chain.push(await resolveSshHopNode(entry, context, seen, depth + 1));
      seen.delete(hopKey);
    }
    return { kind: "jump", chain };
  }
  if (parsed.proxyCommand) {
    return {
      kind: "command",
      // token 替换在解析层完成：这里同时持有目标主机的 host/port/user 完整上下文。
      command: expandProxyCommand(parsed.proxyCommand, {
        host: node.host,
        port: node.port,
        user: node.username,
      }),
      targetHost: node.host,
      targetPort: node.port,
    };
  }
  return undefined;
}

/** 解析单个跳板节点：再用 `ssh -G` 解析该跳（跳板自身可再配 ProxyJump / ProxyCommand，递归）。 */
async function resolveSshHopNode(
  entry: { user?: string; host: string; port?: number },
  context: SshConfigResolutionContext,
  seen: Set<string>,
  depth: number,
): Promise<SshConnectionNode> {
  const output = await runSshGQuery({
    sshExecutablePath: context.sshExecutablePath,
    query: entry.host,
  });
  if (!output) {
    // 跳板解析失败意味着无法建立链路；显式报错优于静默直连（直连几乎必然失败且难排查）。
    throw new Error(`无法解析跳板机配置：${entry.host}（ssh -G 失败，请检查 ~/.ssh/config）`);
  }
  const parsed = parseSshGEffectiveConfig(output);
  const node: SshConnectionNode = {
    host: parsed.hostname?.trim() || entry.host,
    port: entry.port ?? parsed.port ?? 22,
    username: entry.user ?? parsed.user?.trim() ?? localFallbackUsername(),
    identityFiles: parsed.identityFiles.map(expandIdentityFilePath),
  };
  if (!node.username) {
    throw new Error(`无法确定跳板机 ${entry.host} 的登录用户，请在 config 中显式配置 User`);
  }
  if (parsed.proxyJump && parsed.proxyCommand) {
    throw new Error(
      `跳板机 ${entry.host} 同时配置了 ProxyJump 与 ProxyCommand（OpenSSH 互斥），请修改 ~/.ssh/config 后重试`,
    );
  }
  node.via = await resolveVia(parsed, node, context, seen, depth);
  return node;
}
