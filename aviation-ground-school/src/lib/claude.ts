import Anthropic from "@anthropic-ai/sdk";
import { env } from "@/lib/env";

let _client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!_client) {
    _client = new Anthropic({ apiKey: env.anthropicApiKey });
  }
  return _client;
}

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

/**
 * Sends the conversation so far to Claude with the chatbot's country/license-specific
 * system prompt and returns the assistant's reply text.
 */
export async function generateChatbotReply(systemPrompt: string, history: ChatTurn[]): Promise<string> {
  const client = getClient();

  const response = await client.messages.create({
    model: env.anthropicModel,
    max_tokens: 1024,
    system: systemPrompt,
    messages: history.map((turn) => ({ role: turn.role, content: turn.content })),
  });

  const textBlock = response.content.find((block) => block.type === "text");
  return textBlock && textBlock.type === "text" ? textBlock.text : "";
}
