export const Channels = {
  1: 'MONO',
  2: 'STEREO',
  /** Mono */
  MONO: 1,
  /** Stereo */
  STEREO: 2,
} as const;
export type Channels = typeof Channels.MONO | typeof Channels.STEREO;

export const AudioEncoding = {
  /** 16-bit signed little-endian (PCM) */
  LINEAR16: 'linear16',
  /** Ogg Opus */
  OPUS: 'opus',
} as const;
export type AudioEncoding = (typeof AudioEncoding)[keyof typeof AudioEncoding];
