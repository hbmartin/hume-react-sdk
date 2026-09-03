/** A binary assistant-audio message decoded from WebSocket data. */
export type ParsedAudioMessage = {
  type: 'audio';
  data: ArrayBuffer;
  receivedAt: Date;
};

export type BinaryMessageData = Blob | ArrayBuffer | ArrayBufferView;

export const isBinaryMessageData = (
  data: unknown,
): data is BinaryMessageData => {
  return (
    (typeof Blob !== 'undefined' && data instanceof Blob) ||
    data instanceof ArrayBuffer ||
    ArrayBuffer.isView(data)
  );
};

const copyViewToArrayBuffer = (view: ArrayBufferView): ArrayBuffer => {
  const copy = new Uint8Array(view.byteLength);
  copy.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  return copy.buffer;
};

export const parseAudioMessage = async (
  data: BinaryMessageData,
): Promise<ParsedAudioMessage> => {
  let buffer: ArrayBuffer;
  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    buffer = await data.arrayBuffer();
  } else if (data instanceof ArrayBuffer) {
    buffer = data;
  } else if (ArrayBuffer.isView(data)) {
    buffer = copyViewToArrayBuffer(data);
  } else {
    throw new TypeError('Unsupported binary message data.');
  }

  return {
    type: 'audio',
    data: buffer,
    receivedAt: new Date(),
  };
};
