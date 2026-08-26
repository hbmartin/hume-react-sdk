import { Channels } from '@humeai/assistant';
import { describe, expect, it, vi } from 'vitest';

import { getStreamSettings } from './getMicrophoneDefaults';

const createStream = (settings: MediaTrackSettings) => {
  const track = {
    getSettings: vi.fn(() => settings),
  } as unknown as MediaStreamTrack;

  return {
    getAudioTracks: vi.fn(() => [track]),
  } as unknown as MediaStream;
};

describe('getStreamSettings', () => {
  it('uses the track settings negotiated by the browser', () => {
    const result = getStreamSettings(
      createStream({ sampleRate: 44_100, channelCount: Channels.STEREO }),
      { sampleRate: 16_000, channelCount: Channels.MONO },
    );

    expect(result).toEqual({
      sampleRate: 44_100,
      channelCount: Channels.STEREO,
    });
  });

  it('falls back to requested values when settings are unavailable', () => {
    const result = getStreamSettings(createStream({}), {
      sampleRate: 16_000,
      channelCount: Channels.STEREO,
    });

    expect(result).toEqual({
      sampleRate: 16_000,
      channelCount: Channels.STEREO,
    });
  });

  it('rejects an unsupported negotiated channel count', () => {
    expect(() =>
      getStreamSettings(createStream({ channelCount: 6 }), {}),
    ).toThrow('Unsupported microphone channel count: 6');
  });
});
