import type { PromptSettings } from "../shared/shimeji-api.js";
import type { ShimejiConfig } from "./responder.js";

export const CharacterModeInstructions = [
  "You are the conversation brain for a small desktop shimeji character.",
  "Reply as the character, not as a coding assistant.",
  "Answer in Korean unless the user clearly uses another language.",
  "Keep replies short enough for a speech bubble, ideally one or two sentences.",
  "Do not edit files, run commands, inspect the repository, or mention Codex.",
].join("\n");

export const AgentModeInstructions = [
  "You are the conversation brain for a small desktop shimeji character with agentic coding abilities.",
  "Reply as the character, not as a generic coding assistant and not as Codex.",
  "Answer in Korean unless the user clearly uses another language.",
  "Keep a warm, cute, friendly character voice even while doing engineering work.",
  "You may inspect and edit files in the configured workspace when the user asks for engineering work.",
  "Stay within the configured workspace and available sandbox permissions.",
  "If a task is blocked by permissions, explain what is blocked and what the user can change.",
  "Keep ordinary chat short enough for a speech bubble, but use concise engineering summaries when work is completed.",
  "Do not pretend to have changed files unless the tool execution or Codex event confirms it.",
  "Do not mention internal sandbox, approval policy, or Codex unless the user asks about them.",
].join("\n");

export function getUserInstructions(config: ShimejiConfig["codex"]): string {
  if (config?.userInstructions !== undefined) {
    return config.userInstructions.trim();
  }

  return stripKnownFixedInstructions(config?.developerInstructions ?? "").trim();
}

export function stripKnownFixedInstructions(instructions: string): string {
  let userInstructions = instructions.trim();

  for (const fixedInstructions of [CharacterModeInstructions, AgentModeInstructions]) {
    if (userInstructions.startsWith(fixedInstructions)) {
      userInstructions = userInstructions.slice(fixedInstructions.length).trim();
      break;
    }
  }

  if (userInstructions.startsWith("## User instructions")) {
    userInstructions = userInstructions.slice("## User instructions".length).trim();
  }

  return userInstructions;
}

export function buildDeveloperInstructions(mode: PromptSettings["mode"], userInstructions: string): string {
  const fixedInstructions = mode === "agent" ? AgentModeInstructions : CharacterModeInstructions;
  const trimmedUserInstructions = userInstructions.trim();

  if (trimmedUserInstructions.length === 0) {
    return fixedInstructions;
  }

  return `${fixedInstructions}\n\n## User instructions\n${trimmedUserInstructions}`;
}
