import { describe, expect, it } from 'vitest';

import { AudioEncoding, Channels } from './audio';
import { TTSService } from './ttsService';

// These literals are part of the wire format Hume's API expects; pin the
// exact values so a renamed constant cannot silently change what is sent.
describe('wire-format constants', () => {
  it('pins channel counts', () => {
    expect(Channels.MONO).toBe(1);
    expect(Channels.STEREO).toBe(2);
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
});
