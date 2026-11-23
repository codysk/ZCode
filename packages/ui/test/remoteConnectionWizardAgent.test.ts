import { describe, expect, it } from "vitest";
import {
  buildRemoteTarget,
  collectRemoteFormFieldErrors,
  type RemoteConnectionFormSnapshot,
} from "../src/lib/remoteConnectionWizard.js";

const intl = {
  formatMessage: ({ id }: { id: string }) => id,
};

function sshSnapshot(
  overrides: Partial<RemoteConnectionFormSnapshot> = {},
): RemoteConnectionFormSnapshot {
  return {
    kind: "ssh",
    host: "hailan-xtalpi-work",
    port: "22",
    username: "hailan",
    sshAuthMethod: "password",
    password: "",
    privateKeyPath: "",
    privateKeyPassphrase: "",
    wslDistro: "",
    dockerContainer: "",
    ...overrides,
  };
}

describe("SSH Agent 认证方式（remoteConnectionWizard）", () => {
  it("agent 模式不要求任何凭据", () => {
    const errors = collectRemoteFormFieldErrors(intl, sshSnapshot({ sshAuthMethod: "agent" }));
    expect(errors).toEqual([]);
  });

  it("agent 模式构造的 target 不携带密码与私钥，保留 sshConfigAlias", () => {
    const { target, errorMessage } = buildRemoteTarget(
      intl,
      sshSnapshot({
        sshAuthMethod: "agent",
        selectedSshConfigAlias: "hailan-xtalpi-work",
        password: "should-not-leak",
        privateKeyPath: "/tmp/key",
      }),
    );
    expect(errorMessage).toBeUndefined();
    expect(target).toMatchObject({ kind: "ssh", sshConfigAlias: "hailan-xtalpi-work" });
    expect(target?.kind === "ssh" && target.password).toBeFalsy();
    expect(target?.kind === "ssh" && target.privateKeyPath).toBeFalsy();
    expect(target?.kind === "ssh" && target.privateKeyPassphrase).toBeFalsy();
  });

  it("密码模式仍要求密码（回归）", () => {
    const errors = collectRemoteFormFieldErrors(intl, sshSnapshot({ sshAuthMethod: "password" }));
    expect(errors).toEqual([{ field: "password", message: "ssh.validation.passwordRequired" }]);
  });

  it("私钥模式仍要求私钥路径（回归）", () => {
    const errors = collectRemoteFormFieldErrors(intl, sshSnapshot({ sshAuthMethod: "privateKey" }));
    expect(errors).toEqual([{ field: "privateKey", message: "ssh.validation.privateKeyRequired" }]);
  });
});
