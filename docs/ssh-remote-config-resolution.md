# SSH 远端连接的有效 ssh config 解析

## 背景

远端 SSH 连接由 ssh2 库直连（`packages/server/src/remote/ssh-backend.ts`）。ssh2 不读取
`~/.ssh/config`，也不支持 ProxyJump / ProxyCommand。此前 ssh config 只在连接弹窗回填
alias 的 host/port/username/privateKeyPath（见 [SSH Config Alias](ui/ssh-config-alias.md)），
之后 config 里的修改（HostName、Port、ProxyJump）不会生效；需要跳板才能到达的主机无法连接，
而同一台主机在命令行 `ssh <alias>` 可以正常登录。

## 行为

连接建立时（`SSHBackend.ensureConnected`，含断线后的重连）解析有效配置：

- target 带 `sshConfigAlias`：`ssh -G <alias>`（BatchMode）的解析结果权威，覆盖快照里的
  host/port/username，并读取 identityfile 与代理指令。`ssh` 二进制缺失或 `-G` 失败时
  回退快照值（旧行为），不启用代理。
- target 只有裸 host：port/username/privateKeyPath 保持快照值；连接主机名仍取
  `ssh -G <host>` 的 HostName 解析结果（`input.host` 可能是 config 别名，ssh2 与跳板机
  都无法按别名做 DNS 解析，显式输入语义对齐 `ssh -p/-l`：只覆盖端口与用户）。代理指令
  与 identityfile 照常采纳（对齐 OpenSSH 对 `Host` 通配段的匹配，例如 `Host *` 的
  ProxyJump 对所有目标生效）。identityfile 仅在未显式提供 privateKeyPath 时采用。
- `-G` 不传 `-F`，走 ssh 默认的配置解析顺序（系统配置 + `~/.ssh/config`），与命令行
  `ssh` 实际行为一致。

### 代理执行

- ProxyJump：按 OpenSSH 语义展开逗号分隔的 `[user@]host[:port]` 跳板链（支持 IPv6
  `[::1]:22` 写法）。每跳再用 `ssh -G` 解析（跳板自身配置的 ProxyJump 递归生效，
  深度上限 8，出现环时解析失败并报错）。逐跳建立嵌套 ssh2 连接，上一跳 `forwardOut`
  的 channel 作为下一跳的 sock，最终通道作为目标主机的 sock。
- ProxyCommand：`/bin/sh -c <展开后的命令>`（Windows 用 `cmd.exe /c`），`%h/%p/%r/%%`
  按目标主机替换；子进程 stdin/stdout 组合为 Duplex 作为 sock。子进程提前退出或报错
  视为连接失败。
- ProxyJump 与 ProxyCommand 同时配置视为解析错误（对齐 OpenSSH 的互斥行为）。

### 认证

- 跳板机认证顺序：config identityfile（第一个存在的文件）→ SSH agent →
  连接密码兜底（keyboard-interactive）。跳板与目标主机共用 UI 保存的密码。
- 目标主机认证语义不变（`packages/server/src/remote/sshAuth.ts` 的
  `buildSSHConnectConfig` 规则继续生效）；config 解析出的 identityfile 以私钥内容
  参与认证，passphrase 仍来自 target。

### 生命周期

- 代理链的所有 ssh2 client、channel 与 ProxyCommand 子进程由 SSHBackend 统一登记，
  dispose、连接失败、断线重连路径都必须完整销毁，不允许残留进程或 socket。
- 解析与建链阶段可被 dispose 取消：在途 `ensureConnected` 立即失败（复用
  `failPendingConnect` 出口），后台迟到的建链结果发现 disposed 后自行销毁。
- 断线重连时先销毁旧代理链再重新解析（config 可能在两次连接之间变化）。

## 实现要点

- 解析与跳板链实现位于 `packages/server/src/remote/sshConfigResolution.ts`（`ssh -G`
  运行与解析、跳板链展开、ProxyCommand token 替换）与
  `packages/server/src/remote/sshProxyTransport.ts`（嵌套连接与流组装）；SSHBackend
  只在 `ensureConnected` 边界接线，不向 exec/上传链路扩散。
- `ssh` 可执行文件探测复用 `packages/services/src/system/sshConfigAlias.ts` 的
  `resolveSshExecutablePath`（新增导出），macOS/Linux/Windows 探测路径保持一致。
- 不改变 workspace identity：alias 依旧不参与身份计算（见
  [SSH Config Alias](ui/ssh-config-alias.md)）。
- 跳板失败与目标主机失败的错误文案区分到具体跳（第几跳、哪台主机），便于定位。
- 纯解析逻辑（`-G` 输出解析、跳板链展开、token 替换）由工程 Vitest 覆盖
  （`packages/server/test/sshConfigResolution.test.ts`）；真实多跳 E2E 需要跳板环境，
  依赖 `docs/testing/ssh-remote-p0-e2e-plan.md` 的容器方案另行扩展。
