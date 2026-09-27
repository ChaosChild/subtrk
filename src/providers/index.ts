// Provider registry – the single list core iterates under Promise.allSettled.

import type { ProviderId, ProviderModule } from "../core.ts";
import alibaba from "./alibaba.ts";
import claude from "./claude.ts";
import glm from "./glm.ts";
import google from "./google.ts";
import kimi from "./kimi.ts";
import openai from "./openai.ts";
import opencode from "./opencode.ts";
import openrouter from "./openrouter.ts";

export const allProviders: ProviderModule[] = [claude, glm, alibaba, google, opencode, openrouter, openai, kimi];

// Ids whose module offers interactive refresh (subtrk auth refresh / POST /api/refresh).
export function refreshableProviders(): ProviderId[] {
  return allProviders.filter((m) => typeof m.refresh === "function").map((m) => m.id);
}
