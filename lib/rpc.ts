// A fetch-backed twin of the `useRpc` hook.
//
// Ported from bb-plugin-floating-terminal. The floating surfaces are mounted
// by a content script rather than a React slot, so they have no plugin React
// context to read `useRpc` from. The wire format is public and stable, so we
// speak it directly and keep the same contract-derived typing. The panels use
// this client too — one data path for every surface.
import type {
  PluginRpcCallArgs,
  PluginRpcClient,
  PluginRpcContract,
  PluginRpcResult,
} from "@bb/plugin-sdk/app";

export class PluginRpcCallError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "PluginRpcCallError";
    this.code = code;
  }
}

interface RpcEnvelope {
  ok?: unknown;
  result?: unknown;
  error?: { message?: unknown; code?: unknown };
}

export function createRpcClient<Contract extends PluginRpcContract>(
  pluginId: string,
): PluginRpcClient<Contract> {
  return {
    async call<Method extends Extract<keyof Contract, string>>(
      method: Method,
      ...args: PluginRpcCallArgs<Contract[Method]>
    ): Promise<PluginRpcResult<Contract[Method]>> {
      const response = await fetch(
        `/api/v1/plugins/${pluginId}/rpc/${encodeURIComponent(method)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(args[0] ?? null),
        },
      );

      let envelope: RpcEnvelope;
      try {
        envelope = (await response.json()) as RpcEnvelope;
      } catch {
        throw new PluginRpcCallError(
          `${method} failed (HTTP ${response.status})`,
          "non_json_result",
        );
      }

      if (envelope.ok !== true) {
        const message =
          typeof envelope.error?.message === "string"
            ? envelope.error.message
            : `${method} failed (HTTP ${response.status})`;
        const code =
          typeof envelope.error?.code === "string"
            ? envelope.error.code
            : "handler_error";
        throw new PluginRpcCallError(message, code);
      }

      return envelope.result as PluginRpcResult<Contract[Method]>;
    },
  };
}
