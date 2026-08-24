import { describe, expect, it } from 'vitest';

import { AudioEncoding, Channels } from './audio';
import { LanguageModelOption } from './llm';
import { TTSService } from './ttsService';

// These literals are part of the wire format Hume's API expects; pin the
// exact values so a renamed constant cannot silently change what is sent.
describe('wire-format constants', () => {
  it('pins channel counts', () => {
    expect(Channels.MONO).toBe(1);
    expect(Channels.STEREO).toBe(2);
    expect(Channels[1]).toBe('MONO');
    expect(Channels[2]).toBe('STEREO');
  });

  it('pins audio encodings', () => {
    expect(AudioEncoding.LINEAR16).toBe('linear16');
    expect(AudioEncoding.OPUS).toBe('opus');
  });

  it('pins TTS service identifiers', () => {
    expect(TTSService.DEFAULT).toBe('hume_ai');
    expect(TTSService.ELEVEN_LABS).toBe('eleven_labs');
    expect(TTSService.PLAY_HT).toBe('play_ht');
  });

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
