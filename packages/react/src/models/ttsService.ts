export const TTSService = {
  /** Hume's Text-To-Speech */
  DEFAULT: 'hume_ai',
  /** ElevenLab's Text-To-Speech */
  ELEVEN_LABS: 'eleven_labs',
  /** Play HT's Text-To-Speech */
  PLAY_HT: 'play_ht',
} as const;
// eslint-disable-next-line @typescript-eslint/no-redeclare -- intentional const + type pairing
export type TTSService = (typeof TTSService)[keyof typeof TTSService];
