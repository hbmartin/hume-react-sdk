/** Text-to-speech provider used to synthesize assistant audio. */
export const TTSService = {
  /** Hume's Text-To-Speech */
  DEFAULT: 'hume_ai',
  /** ElevenLab's Text-To-Speech */
  ELEVEN_LABS: 'eleven_labs',
  /** Play HT's Text-To-Speech */
  PLAY_HT: 'play_ht',
} as const;
/** Text-to-speech provider used to synthesize assistant audio. */
export type TTSService = (typeof TTSService)[keyof typeof TTSService];
