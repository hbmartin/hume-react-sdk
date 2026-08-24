export const Channels = {
  1: 'MONO',
  2: 'STEREO',
  /** Mono */
  MONO: 1,
  /** Stereo */
  STEREO: 2,
} as const;
// eslint-disable-next-line @typescript-eslint/no-redeclare -- intentional const + type pairing
export type Channels = typeof Channels.MONO | typeof Channels.STEREO;

export const AudioEncoding = {
  /** 16-bit signed little-endian (PCM) */
  LINEAR16: 'linear16',
  /** Ogg Opus */
  OPUS: 'opus',
} as const;
// eslint-disable-next-line @typescript-eslint/no-redeclare -- intentional const + type pairing
export type AudioEncoding = (typeof AudioEncoding)[keyof typeof AudioEncoding];
