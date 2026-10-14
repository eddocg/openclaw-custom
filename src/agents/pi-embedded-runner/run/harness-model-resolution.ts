import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { selectAgentHarness } from "../../harness/selection.js";
import type { AgentHarness } from "../../harness/types.js";
import { ensureOpenClawModelsJson } from "../../models-config.js";
import { resolveModelAsync } from "../model.js";

export type EmbeddedRunHarnessModelResolution = {
  agentHarness: AgentHarness;
  pluginHarnessOwnsTransport: boolean;
  modelResolution: Awaited<ReturnType<typeof resolveModelAsync>>;
};

/**
 * Selects the agent harness for a run, then resolves the model the way that
 * harness needs it. PI runs fall back to generating and reading models.json;
 * plugin harnesses own their transport and only use the lean resolver.
 */
export async function resolveEmbeddedRunHarnessAndModel(params: {
  provider: string;
  modelId: string;
  config?: OpenClawConfig;
  agentDir: string;
  agentId?: string;
  sessionKey?: string;
  agentHarnessId?: string;
  workspaceDir: string;
}): Promise<EmbeddedRunHarnessModelResolution> {
  const { provider, modelId, config, agentDir, workspaceDir } = params;
  const agentHarness = selectAgentHarness({
    provider,
    modelId,
    config,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    agentHarnessId: params.agentHarnessId,
  });
  const pluginHarnessOwnsTransport = agentHarness.id !== "pi";
  const dynamicModelResolution = await resolveModelAsync(provider, modelId, agentDir, config, {
    // Plugin dynamic model hooks can resolve explicit model refs without
    // first generating PI models.json. This keeps one-shot model runs from
    // blocking on unrelated provider discovery.
    skipPiDiscovery: true,
    workspaceDir,
  });
  if (dynamicModelResolution.model) {
    return { agentHarness, pluginHarnessOwnsTransport, modelResolution: dynamicModelResolution };
  }
  if (pluginHarnessOwnsTransport) {
    return {
      agentHarness,
      pluginHarnessOwnsTransport,
      modelResolution: {
        ...dynamicModelResolution,
        error: formatPluginHarnessModelMiss({
          harnessId: agentHarness.id,
          provider,
          modelId,
          error: dynamicModelResolution.error,
        }),
      },
    };
  }
  await ensureOpenClawModelsJson(config, agentDir, { workspaceDir });
  return {
    agentHarness,
    pluginHarnessOwnsTransport,
    modelResolution: await resolveModelAsync(provider, modelId, agentDir, config, {
      workspaceDir,
    }),
  };
}

// Plugin harnesses never read PI's models.json, so a model that only provider
// catalog discovery knows about is unknown here. Say how to route it to PI.
function formatPluginHarnessModelMiss(params: {
  harnessId: string;
  provider: string;
  modelId: string;
  error?: string;
}): string {
  const base = params.error ?? `Unknown model: ${params.provider}/${params.modelId}`;
  return (
    `${base} (agent runtime "${params.harnessId}" does not read models.json; if ` +
    `\`models list\` shows this model, set agentRuntime.id "pi" on ` +
    `agents.defaults.models["${params.provider}/${params.modelId}"] to run it through PI)`
  );
}
