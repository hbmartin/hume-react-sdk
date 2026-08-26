import { Channels } from '@humeai/assistant';

const DEFAULT_SAMPLE_RATE = 48_000;

export type EncodingValues = {
  sampleRate: number;
  channelCount: Channels;
};

const getChannelCount = (
  negotiatedChannelCount: number | undefined,
  requestedChannelCount: number | undefined,
): Channels => {
  const channelCount =
    negotiatedChannelCount ?? requestedChannelCount ?? Channels.MONO;

  if (channelCount === Number(Channels.MONO)) {
    return Channels.MONO;
  }
  if (channelCount === Number(Channels.STEREO)) {
    return Channels.STEREO;
  }

  throw new Error(`Unsupported microphone channel count: ${channelCount}`);
};

const getStreamSettings = (
  stream: MediaStream,
  encodingConstraints: Partial<EncodingValues>,
): EncodingValues => {
  const tracks = stream.getAudioTracks();

  if (tracks.length !== 1) {
    throw new Error(
      tracks.length === 0 ? 'No audio tracks' : 'Multiple audio tracks',
    );
  }

  const track = tracks[0];
  if (!track) {
    throw new Error('No audio track');
  }

  const settings = track.getSettings();

  return {
    sampleRate:
      settings.sampleRate ??
      encodingConstraints.sampleRate ??
      DEFAULT_SAMPLE_RATE,
    channelCount: getChannelCount(
      settings.channelCount,
      encodingConstraints.channelCount,
    ),
  };
};

export { getStreamSettings };
