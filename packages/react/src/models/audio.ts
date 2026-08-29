/** Channel layout of an audio stream. */
export const Channels = {
  1: 'MONO',
  2: 'STEREO',
  /** Mono */
  MONO: 1,
  /** Stereo */
  STEREO: 2,
} as const;
/** Channel layout of an audio stream. */
export type Channels = typeof Channels.MONO | typeof Channels.STEREO;

/** Encoding of an audio payload sent to or received from EVI. */
export const AudioEncoding = {
  /** 16-bit signed little-endian (PCM) */
  LINEAR16: 'linear16',
  /** Ogg Opus */
  OPUS: 'opus',
} as const;
/** Encoding of an audio payload sent to or received from EVI. */
export type AudioEncoding = (typeof AudioEncoding)[keyof typeof AudioEncoding];
