/**
 * @deprecated Language model selection moved into server-side EVI
 * configuration, and this list has not tracked the models EVI supports since
 * it was written. Choose a model in your EVI config and reference it with
 * `configId`. Slated for removal in the next major version.
 */
export const LanguageModelOption = {
  CLAUDE_3_OPUS: 'CLAUDE_3_OPUS',
  CLAUDE_3_SONNET: 'CLAUDE_3_SONNET',
  CLAUDE_3_HAIKU: 'CLAUDE_3_HAIKU',
  CLAUDE_21: 'CLAUDE_21',
  CLAUDE_INSTANT_12: 'CLAUDE_INSTANT_12',
  GPT_4_TURBO_PREVIEW: 'GPT_4_TURBO_PREVIEW',
  GPT_35_TURBO_0125: 'GPT_35_TURBO_0125',
  GPT_35_TURBO: 'GPT_35_TURBO',
  FIREWORKS_MIXTRAL_8X7B: 'FIREWORKS_MIXTRAL_8X7B',
} as const;
/**
 * @deprecated Language model selection moved into server-side EVI
 * configuration, and this list has not tracked the models EVI supports since
 * it was written. Choose a model in your EVI config and reference it with
 * `configId`. Slated for removal in the next major version.
 */
export type LanguageModelOption =
  (typeof LanguageModelOption)[keyof typeof LanguageModelOption];
