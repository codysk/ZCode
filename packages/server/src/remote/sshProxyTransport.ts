/* 代理链传输层：把 config 解析出的 via（ProxyJump 链 / ProxyCommand）折叠成一个可交给 ssh2 的 Duplex sock。
   所有中途创建的 ssh2 client、channel 与子进程统一登记到 dispose registry，保证任何失败路径都能完整清理。 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { Duplex } from "node:stream";
import type { Client as SSH2Client, ClientChannel, ConnectConfig } from "ssh2";
import { buildSSHConnectConfig, createKeyboardInteractiveResponder } from "./sshAuth.js";
import { readUsablePrivateKey, type SshConnectionNode } from "./sshConfigResolution.js";

// ssh2 是 CJS 包；类型走 import type，运行时构造器按需 require，避免打包边界问题。
const require = createRequire(import.meta.url);
const { Client: Ssh2Client } = require("ssh2") as { Client: typeof SSH2Client };

export interface SshProxyTransport {
  /** 已建立到目标节点 host:port 的裸流，作为 SSHBackend 主 client 的 sock。 */
  stream: Duplex;
  /** 销毁整条链路（跳板 client、channel、ProxyCommand 子进程）。 */
  dispose(): void;
}

export interface SshProxyTransportOptions {
  /** 跳板认证兜底密码（与目标主机共用 UI 保存的密码）。 */
  password?: string;
  privateKeyPassphrase?: string;
  onLog?: (message: string) => void;
}

interface DisposableResource {
  dispose(reason: string): void;
}

/** 建立到 node.host:node.port 的裸流；仅用于带 via（ProxyJump / ProxyCommand）的节点。 */
export async function openSshNodeStream(
  node: SshConnectionNode,
  options: SshProxyTransportOptions,
): Promise<SshProxyTransport> {
  const registry = new DisposableRegistry(options.onLog);
  try {
    const stream = await openNodeStream(node, options, registry);
    return { stream, dispose: () => registry.disposeAll("proxy transport released") };
  } catch (error) {
    registry.disposeAll("proxy transport failed");
    throw error;
  }
}

class DisposableRegistry {
  private readonly resources: DisposableResource[] = [];

  constructor(private readonly onLog?: (message: string) => void) {}

  track(resource: DisposableResource): void {
    this.resources.push(resource);
  }

  disposeAll(reason: string): void {
    // 逆序销毁：先断最外层（新建立的），让底层 client 的 close 先落地，减少 ssh2 迟到事件。
    while (this.resources.length > 0) {
      const resource = this.resources.pop();
      try {
        resource?.dispose(reason);
      } catch (error) {
        this.onLog?.(`[ssh-proxy] dispose 出错（忽略）：${describeError(error)}`);
      }
    }
  }
}

async function openNodeStream(
  node: SshConnectionNode,
  options: SshProxyTransportOptions,
  registry: DisposableRegistry,
): Promise<Duplex> {
  if (!node.via) {
    // 无代理：ssh2 主 client 自行 TCP，这里不该被调用。
    throw new Error("openSshNodeStream 需要节点带 via（ProxyJump / ProxyCommand）");
  }
  if (node.via.kind === "command") {
    return openProxyCommandStream(node.via.command, options, registry);
  }
  return openJumpChainStream(node, node.via.chain, options, registry);
}

/** ProxyCommand：spawn 展开后的命令（解析层已完成 %h/%p/%r 替换），stdin/stdout 组合为 Duplex。 */
function openProxyCommandStream(
  command: string,
  options: SshProxyTransportOptions,
  registry: DisposableRegistry,
): Promise<Duplex> {
  options.onLog?.(`[ssh-proxy] ProxyCommand: ${command}`);
  const isWindows = process.platform === "win32";
  // 对齐 OpenSSH：POSIX 用 /bin/sh -c，Windows 用 cmd.exe /c。
  const child = isWindows
    ? spawn(process.env["ComSpec"] ?? "cmd.exe", ["/c", command], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      })
    : spawn("/bin/sh", ["-c", command], { stdio: ["pipe", "pipe", "pipe"] });

  const stream = new Duplex({
    read() {},
    write(chunk: Buffer, _encoding, callback) {
      child.stdin.write(chunk, callback);
    },
    final(callback) {
      child.stdin.end();
      callback();
    },
  });

  const failStream = (message: string) => {
    options.onLog?.(`[ssh-proxy] ProxyCommand 失败：${message}`);
    stream.destroy(new Error(`ProxyCommand 连接失败：${message}`));
  };

  child.stdout.on("data", (chunk: Buffer) => {
    stream.push(chunk);
  });
  child.stdout.on("end", () => {
    stream.push(null);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    // stderr 只用于诊断，不影响流；失败提示主要靠退出码与 ssh2 的错误归一化。
    options.onLog?.(`[ssh-proxy] ProxyCommand stderr: ${chunk.toString().trim()}`);
  });
  child.on("error", (error) => failStream(describeError(error)));
  child.on("close", (code) => {
    if (code != null && code !== 0) {
      failStream(`命令退出码 ${code}`);
    }
  });

  registry.track({
    dispose(reason) {
      stream.destroy();
      if (child.exitCode == null && child.signalCode == null) {
        child.kill();
      }
      options.onLog?.(`[ssh-proxy] ProxyCommand 已终止（${reason}）`);
    },
  });
  return Promise.resolve(stream);
}

/** ProxyJump 链：依次连接 chain 中的跳板，最后一跳 forwardOut 到目标节点。 */
async function openJumpChainStream(
  target: SshConnectionNode,
  chain: SshConnectionNode[],
  options: SshProxyTransportOptions,
  registry: DisposableRegistry,
): Promise<Duplex> {
  const firstHop = chain[0];
  if (!firstHop) {
    throw new Error("ProxyJump 跳板链为空");
  }
  // 第一跳的底层流：跳板自身可能还带 via（config 递归），交给同一实现处理。
  let upstream: Duplex | undefined;
  if (firstHop.via) {
    const nested = await openSshNodeStream(firstHop, options);
    // 嵌套链有独立 registry；把它的整体销毁托管进当前 registry。
    registry.track({ dispose: (_reason) => nested.dispose() });
    upstream = nested.stream;
  }

  let currentClient = await connectSshHop(firstHop, upstream, options, registry);
  for (let i = 1; i < chain.length; i += 1) {
    const nextHop = chain[i];
    if (!nextHop) {
      throw new Error("ProxyJump 跳板链为空");
    }
    const channel = await forwardOutThrough(currentClient, nextHop, registry, i);
    currentClient = await connectSshHop(nextHop, channel, options, registry);
  }
  return await forwardOutThrough(currentClient, target, registry, chain.length);
}

/** 用 ssh2 建立到单个跳板的 SSH 会话；认证顺序：identityfile → agent → 密码兜底。 */
async function connectSshHop(
  hop: SshConnectionNode,
  upstream: Duplex | undefined,
  options: SshProxyTransportOptions,
  registry: DisposableRegistry,
): Promise<SSH2Client> {
  const privateKey = await readUsablePrivateKey(hop.identityFiles, options.privateKeyPassphrase);
  options.onLog?.(
    privateKey
      ? `[ssh-proxy] 跳板 ${hop.host} 采用 config identityfile`
      : `[ssh-proxy] 跳板 ${hop.host} 无可用 identityfile，走 agent / 密码认证`,
  );
  const hasPassword = typeof options.password === "string" && options.password.length > 0;
  const config: ConnectConfig = {
    ...buildSSHConnectConfig({
      host: hop.host,
      port: hop.port,
      username: hop.username,
      privateKey,
      passphrase: privateKey ? options.privateKeyPassphrase : undefined,
      password: options.password,
      // 跳板优先走密钥/agent；有密码时 buildSSHConnectConfig 会禁用隐式 agent，
      // 这里显式传 agent 让“密钥失败回落 agent”的路径仍然可用。
      agent: process.env["SSH_AUTH_SOCK"],
    }),
    ...(upstream ? { sock: upstream } : {}),
  };
  if (!privateKey && !hasPassword && !config.agent) {
    throw new Error(
      `跳板机 ${hop.host} 没有可用认证方式：请在 ~/.ssh/config 为其配置 IdentityFile，或使用 SSH agent / 连接密码`,
    );
  }

  const client: SSH2Client = new Ssh2Client();
  registry.track({
    dispose(reason) {
      options.onLog?.(`[ssh-proxy] 结束跳板会话 ${hop.host}（${reason}）`);
      client.end();
    },
  });

  return await new Promise<SSH2Client>((resolve, reject) => {
    const settle = () => {
      client.off("ready", handleReady);
      client.off("error", handleError);
    };
    const handleReady = () => {
      settle();
      options.onLog?.(`[ssh-proxy] 跳板 ${hop.host} 会话就绪`);
      resolve(client);
    };
    const handleError = (error: unknown) => {
      settle();
      reject(new Error(`跳板机 ${hop.host} 连接失败：${describeError(error)}`, { cause: error }));
    };
    client.once("ready", handleReady);
    client.once("error", handleError);
    if (hasPassword) {
      (
        client as unknown as {
          on(event: string, listener: (...args: unknown[]) => void): void;
        }
      ).on(
        "keyboard-interactive",
        createKeyboardInteractiveResponder(options.password) as unknown as (
          ...args: unknown[]
        ) => void,
      );
    }
    options.onLog?.(`[ssh-proxy] 连接跳板 ${hop.username}@${hop.host}:${hop.port}`);
    client.connect(config);
  });
}

/** 通过已连接的跳板 client 打开到 next 节点的 TCP 通道。 */
function forwardOutThrough(
  client: SSH2Client,
  next: SshConnectionNode,
  registry: DisposableRegistry,
  hopIndex: number,
): Promise<Duplex> {
  return new Promise<Duplex>((resolve, reject) => {
    client.forwardOut("127.0.0.1", 0, next.host, next.port, (error, channel: ClientChannel) => {
      if (error) {
        reject(
          new Error(
            `第 ${hopIndex} 跳转发到 ${next.host}:${next.port} 失败：${describeError(error)}`,
            {
              cause: error,
            },
          ),
        );
        return;
      }
      registry.track({
        dispose(reason) {
          void reason;
          channel.close();
        },
      });
      resolve(channel);
    });
  });
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
