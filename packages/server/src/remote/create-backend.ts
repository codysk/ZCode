import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import type { RemoteTarget } from "@zcode/shared";
import type { IRemoteBackend } from "./backend.js";

export async function createRemoteBackend(target: RemoteTarget): Promise<IRemoteBackend> {
  switch (target.kind) {
    case "ssh": {
      const { SSHBackend } = await import("./ssh-backend.js");
      let privateKey: string | Buffer | undefined;
      if (target.privateKeyPath) {
        const keyPath = target.privateKeyPath.replace(/^~/, homedir());
        try {
          privateKey = await readFile(keyPath);
        } catch (error) {
          // Bug 原因：privateKeyPath 指到目录（或不可读文件）时 readFile 抛 EISDIR/EACCES，
          // 会把整个 profile 的连接直接判死；ssh 的语义是“这份密钥材料不可用就换下一认证方式”
          // （agent / 密码 / config identityfile 仍可继续）。这里记录告警后按无显式私钥继续。
          console.warn(`[ssh] 读取 privateKeyPath 失败，改用其他认证方式: ${keyPath}:`, error);
        }
      }

      return new SSHBackend({
        host: target.host,
        port: target.port,
        username: target.username,
        sshConfigAlias: target.sshConfigAlias,
        password: target.password,
        privateKeyPath: target.privateKeyPath,
        privateKeyPassphrase: target.privateKeyPassphrase,
        privateKey,
      });
    }
    case "wsl": {
      const { WSLBackend } = await import("./wsl-backend.js");
      return new WSLBackend(target);
    }
    case "docker": {
      const { DockerBackend } = await import("./docker-backend.js");
      return new DockerBackend(target);
    }
    case "server":
      throw new Error("server remote target connects to an existing server and has no deploy backend");
  }
}
