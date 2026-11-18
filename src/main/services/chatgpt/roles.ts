/**
 * Picks ChatGPT models for the three roles when ChatGPT is the only way to build.
 * Pure (type imports only) so scripts/test-chatgpt.mjs can load it.
 *
 * OpenAI doesn't publish which models plan sign-in exposes (each account gets its own
 * /v1/models list), so this prefers known names and falls back to the list order.
 * Builder prefers Sol (strong at code, efficient with tokens), then Terra, which is fast and
 * lighter on the plan. Luna and other small models handle naming and host.ai().
 */
import type { ModelInfo, Settings } from '../../../shared/types'

/** Builder preference, best first: strongest at code, then lighter on the plan. */
const BUILDER_RES = [/\bsol\b/i, /\bterra\b/i]
/** Efficient models for naming and host.ai(). */
const SMALL_RE = /\b(luna|mini|nano|lite|flash|small)\b/i

function pick(models: ModelInfo[], re: RegExp): string | undefined {
  return models.find((m) => re.test(m.id) || re.test(m.name))?.id
}

/**
 * Builder: the first Sol model, else Terra, else the first listed. Utility and Naming: the first efficient
 * one (Luna, or a mini/nano-style name), else the Builder model.
 * Null when there are no ChatGPT models to pick from.
 */
export function chatgptRoleDefaults(
  models: ModelInfo[]
): Pick<Settings, 'builderModel' | 'utilityModel' | 'namingModel'> | null {
  const gpt = models.filter((m) => m.id.startsWith('chatgpt:'))
  if (!gpt.length) return null
  const builder = BUILDER_RES.map((re) => pick(gpt, re)).find(Boolean) ?? gpt[0].id
  const small = pick(gpt, SMALL_RE) ?? builder
  return { builderModel: builder, utilityModel: small, namingModel: small }
}
