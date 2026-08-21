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
// eslint-disable-next-line @typescript-eslint/no-redeclare -- intentional const + type pairing
export type LanguageModelOption =
  (typeof LanguageModelOption)[keyof typeof LanguageModelOption];
