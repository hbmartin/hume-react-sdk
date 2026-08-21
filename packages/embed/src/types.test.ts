import { describe, expect, it } from 'vitest';

import { LanguageModelOption } from './types';

describe('wire-format constants', () => {
  it('pins language-model identifiers', () => {
    expect(LanguageModelOption).toEqual({
      CLAUDE_3_OPUS: 'CLAUDE_3_OPUS',
      CLAUDE_3_SONNET: 'CLAUDE_3_SONNET',
      CLAUDE_3_HAIKU: 'CLAUDE_3_HAIKU',
      CLAUDE_21: 'CLAUDE_21',
      CLAUDE_INSTANT_12: 'CLAUDE_INSTANT_12',
      GPT_4_TURBO_PREVIEW: 'GPT_4_TURBO_PREVIEW',
      GPT_35_TURBO_0125: 'GPT_35_TURBO_0125',
      GPT_35_TURBO: 'GPT_35_TURBO',
      FIREWORKS_MIXTRAL_8X7B: 'FIREWORKS_MIXTRAL_8X7B',
    });
  });
});
