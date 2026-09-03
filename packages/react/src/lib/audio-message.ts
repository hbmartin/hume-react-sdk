/** A binary assistant-audio message decoded from WebSocket data. */
export type ParsedAudioMessage = {
  type: 'audio';
  data: ArrayBuffer;
  receivedAt: Date;
};

export type BinaryMessageData = Blob | ArrayBuffer | ArrayBufferView;

// oxlint-disable-next-line typescript/unbound-method -- invoked with the candidate receiver via Reflect.apply
const arrayBufferByteLengthGetter = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype,
  'byteLength',
)?.get;

const blobSizeGetter = (() => {
  if (typeof Blob === 'undefined') return undefined;
  // oxlint-disable-next-line typescript/unbound-method -- invoked with the candidate receiver via Reflect.apply
  return Object.getOwnPropertyDescriptor(Blob.prototype, 'size')?.get;
})();

const hasArrayBufferBrand = (data: unknown): data is ArrayBuffer => {
  if (
    typeof data !== 'object' ||
    data === null ||
    arrayBufferByteLengthGetter === undefined
  ) {
    return false;
  }
  try {
    Reflect.apply(arrayBufferByteLengthGetter, data, []);
    return true;
  } catch {
    return false;
  }
};

const hasBlobBrand = (data: unknown): data is Blob => {
  if (
    typeof data !== 'object' ||
    data === null ||
    blobSizeGetter === undefined
  ) {
    return false;
  }
  try {
    Reflect.apply(blobSizeGetter, data, []);
    return true;
  } catch {
    return false;
  }
};

const isArrayBufferView = (data: unknown): data is ArrayBufferView => {
  try {
    return ArrayBuffer.isView(data);
  } catch {
    return false;
  }
};

export const isBinaryMessageData = (
  data: unknown,
): data is BinaryMessageData => {
  return (
    hasBlobBrand(data) || hasArrayBufferBrand(data) || isArrayBufferView(data)
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
  if (hasBlobBrand(data)) {
    buffer = await data.arrayBuffer();
  } else if (hasArrayBufferBrand(data)) {
    buffer = data;
  } else if (isArrayBufferView(data)) {
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
