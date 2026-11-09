// The only place the case agent talks to Claude. Sonnet 5.5 per the spec; the loop in agent.ts validates everything it returns.

import Anthropic from "@anthropic-ai/sdk";
import type { AgentModel, Block } from "./agent.js";

export const AGENT_MODEL = "claude-sonnet-5-5";

export function createAnthropicAgentModel(apiKey: string): AgentModel {
  const client = new Anthropic({ apiKey });
  return async (req) => {
    const res = await client.messages.create({
      model: AGENT_MODEL,
      max_tokens: 4096,
      system: req.system,
      messages: req.messages as Anthropic.MessageParam[],
      tools: req.tools as Anthropic.Tool[],
      output_config: { effort: "medium" }, // sampling parameters (temperature) are rejected on this model; tools + step limit constrain behaviour
    });
    return {
      content: res.content as unknown as Block[],
      stopReason: res.stop_reason,
      usage: { input: res.usage.input_tokens, output: res.usage.output_tokens },
    };
  };
}
