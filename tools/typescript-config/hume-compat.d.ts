// Hume 0.16.1's ESM declaration for EVIWebAudioPlayer uses an internal
// non-package import. Keep the minimum public shape here so dependency-library
// checks can remain strict until the upstream declaration points at
// `hume/empathicVoice`.
declare module 'api/resources/empathicVoice' {
  export interface AudioOutput {
    customSessionId?: string;
    data: string;
    id: string;
    index: number;
    type: 'audio_output';
  }
}
