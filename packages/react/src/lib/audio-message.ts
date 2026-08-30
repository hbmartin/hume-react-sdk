/** A binary assistant-audio message decoded from a WebSocket blob. */
export type ParsedAudioMessage = {
  type: 'audio';
  data: ArrayBuffer;
  receivedAt: Date;
};

export const parseAudioMessage = async (
  blob: Blob,
): Promise<ParsedAudioMessage | null> => {
  return blob
    .arrayBuffer()
    .then((buffer) => {
      return {
        type: 'audio' as const,
        data: buffer,
        receivedAt: new Date(),
      };
    })
    .catch(() => {
      return null;
    });
};
