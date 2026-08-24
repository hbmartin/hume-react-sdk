import { act, renderHook } from '@testing-library/react';
import { MimeType } from 'hume';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useMicrophone } from './useMicrophone';

type RecorderInstance = {
  stream: MediaStream;
  options?: MediaRecorderOptions;
};

/**
 * Installs a fake `MediaRecorder`. Omitting `isTypeSupported` models an
 * environment that only partially implements the API — a polyfill, an embedded
 * WebView — which is the case that makes `getBrowserSupportedMimeType` throw
 * rather than return a result.
 */
const stubMediaRecorder = (isTypeSupported?: (type: string) => boolean) => {
  const instances: RecorderInstance[] = [];

  class MediaRecorderStub {
    start = vi.fn();

    stop = vi.fn();

    addEventListener = vi.fn();

    removeEventListener = vi.fn();

    constructor(
      public stream: MediaStream,
      public options?: MediaRecorderOptions,
    ) {
      instances.push(this);
    }
  }

  if (isTypeSupported) {
    Object.assign(MediaRecorderStub, {
      isTypeSupported: vi.fn(isTypeSupported),
    });
  }

  vi.stubGlobal('MediaRecorder', MediaRecorderStub);

  return instances;
};

/** Builds an `isTypeSupported` that reports exactly `supported` as available. */
const supports =
  (...supported: MimeType[]) =>
  (type: string) =>
    (supported as string[]).includes(type);

const createAudioContext = () =>
  ({
    sampleRate: 48000,
    createMediaStreamSource: vi.fn(() => ({
      connect: vi.fn(),
      disconnect: vi.fn(),
    })),
    createAnalyser: vi.fn(() => ({
      fftSize: 0,
      frequencyBinCount: 1024,
      getByteFrequencyData: vi.fn(),
    })),
    close: vi.fn(() => Promise.resolve()),
  }) as unknown as AudioContext;

const createStream = () => ({ getTracks: () => [] }) as unknown as MediaStream;

const renderMicrophone = () => {
  const onError = vi.fn();
  const onAudioCaptured = vi.fn();
  const { result, unmount } = renderHook(() =>
    useMicrophone({ onAudioCaptured, onError }),
  );

  return { result, unmount, onError, onAudioCaptured };
};

describe('useMicrophone', () => {
  beforeEach(() => {
    // The fft analyzer reschedules itself through rAF; a no-op keeps it to a
    // single pass so the loop does not outlive the test.
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 1),
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('records with the mime type the browser reports as supported', () => {
    // Safari and iOS support mp4 but not webm.
    const recorders = stubMediaRecorder(supports(MimeType.MP4));
    const { result, onError } = renderMicrophone();

    result.current.start(createStream(), createAudioContext());

    expect(onError).not.toHaveBeenCalled();
    expect(recorders).toHaveLength(1);
    expect(recorders[0]?.options?.mimeType).toBe(MimeType.MP4);
  });

  it('prefers webm when the browser supports more than one type', () => {
    const recorders = stubMediaRecorder(supports(MimeType.WEBM, MimeType.MP4));
    const { result } = renderMicrophone();

    result.current.start(createStream(), createAudioContext());

    expect(recorders[0]?.options?.mimeType).toBe(MimeType.WEBM);
  });

  it('reports an error and refuses to record when MediaRecorder is absent', () => {
    vi.stubGlobal('MediaRecorder', undefined);
    const { result, onError } = renderMicrophone();
    const context = createAudioContext();
    const createMediaStreamSource = vi.spyOn(
      context,
      'createMediaStreamSource',
    );

    expect(onError).toHaveBeenCalledWith(
      'MediaRecorder is not supported',
      'mime_types_not_supported',
    );
    expect(() => result.current.start(createStream(), context)).toThrow(
      'No MimeType specified',
    );
    expect(createMediaStreamSource).not.toHaveBeenCalled();
    expect(requestAnimationFrame).not.toHaveBeenCalled();
  });

  it('reports an error when no candidate mime type is supported', () => {
    stubMediaRecorder(supports());
    const { result, onError } = renderMicrophone();

    expect(onError).toHaveBeenCalledWith(
      'Browser does not support any compatible mime types',
      'mime_types_not_supported',
    );
    expect(() =>
      result.current.start(createStream(), createAudioContext()),
    ).toThrow('No MimeType specified');
  });

  it('reports an error rather than throwing when MediaRecorder is partially implemented', () => {
    stubMediaRecorder();
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    const { result, onError } = renderMicrophone();

    expect(onError).toHaveBeenCalledWith(
      'This browser does not fully support microphone recording.',
      'mime_types_not_supported',
    );
    expect(consoleError).toHaveBeenCalledWith(
      'Failed to detect supported microphone MIME types.',
      expect.any(TypeError),
    );
    expect(() =>
      result.current.start(createStream(), createAudioContext()),
    ).toThrow('No MimeType specified');
    consoleError.mockRestore();
  });

  it('rolls back claimed resources when recorder construction fails', () => {
    class FailingMediaRecorder {
      static isTypeSupported = vi.fn(() => true);

      constructor() {
        throw new Error('recorder construction failed');
      }
    }
    vi.stubGlobal('MediaRecorder', FailingMediaRecorder);
    const sourceDisconnect = vi.fn();
    const contextClose = vi.fn().mockResolvedValue(undefined);
    const context = {
      sampleRate: 48000,
      createMediaStreamSource: vi.fn(() => ({
        connect: vi.fn(),
        disconnect: sourceDisconnect,
      })),
      createAnalyser: vi.fn(() => ({
        fftSize: 0,
        frequencyBinCount: 1024,
        getByteFrequencyData: vi.fn(),
      })),
      close: contextClose,
    } as unknown as AudioContext;
    vi.stubGlobal(
      'AudioContext',
      vi.fn(() => context),
    );
    const trackStop = vi.fn();
    const stream = {
      getTracks: () => [{ stop: trackStop }],
    } as unknown as MediaStream;
    const { result } = renderMicrophone();

    expect(() => result.current.start(stream)).toThrow(
      'recorder construction failed',
    );
    expect(sourceDisconnect).toHaveBeenCalledOnce();
    expect(cancelAnimationFrame).toHaveBeenCalledWith(1);
    expect(trackStop).toHaveBeenCalledOnce();
    expect(contextClose).toHaveBeenCalledOnce();
  });

  it('releases the stream and owned audio context when recorder cleanup throws', () => {
    const recorderStop = vi.fn(() => {
      throw new DOMException('The recorder is inactive', 'InvalidStateError');
    });
    class InactiveMediaRecorder {
      static isTypeSupported = vi.fn(() => true);

      start = vi.fn();

      stop = recorderStop;

      addEventListener = vi.fn();

      removeEventListener = vi.fn();
    }
    vi.stubGlobal('MediaRecorder', InactiveMediaRecorder);

    const contextClose = vi.fn().mockResolvedValue(undefined);
    const context = {
      ...createAudioContext(),
      close: contextClose,
    } as AudioContext;
    vi.stubGlobal(
      'AudioContext',
      vi.fn(() => context),
    );

    const trackStop = vi.fn();
    const stream = {
      getTracks: () => [{ stop: trackStop }],
    } as unknown as MediaStream;
    const { result, unmount } = renderMicrophone();
    result.current.start(stream);

    expect(() => unmount()).not.toThrow();
    expect(recorderStop).toHaveBeenCalledOnce();
    expect(trackStop).toHaveBeenCalledOnce();
    expect(contextClose).toHaveBeenCalledOnce();
  });

  it('releases the stream and owned audio context when stopping an inactive recorder', async () => {
    const recorderStop = vi.fn(() => {
      throw new DOMException('The recorder is inactive', 'InvalidStateError');
    });
    class InactiveMediaRecorder {
      static isTypeSupported = vi.fn(() => true);

      start = vi.fn();

      stop = recorderStop;

      addEventListener = vi.fn();

      removeEventListener = vi.fn();
    }
    vi.stubGlobal('MediaRecorder', InactiveMediaRecorder);

    const contextClose = vi.fn().mockResolvedValue(undefined);
    const context = {
      ...createAudioContext(),
      close: contextClose,
    } as AudioContext;
    vi.stubGlobal(
      'AudioContext',
      vi.fn(() => context),
    );

    const trackStop = vi.fn();
    const stream = {
      getTracks: () => [{ stop: trackStop }],
    } as unknown as MediaStream;
    const { result } = renderMicrophone();
    result.current.start(stream);

    await act(() => result.current.stop());

    expect(recorderStop).toHaveBeenCalledOnce();
    expect(trackStop).toHaveBeenCalledOnce();
    expect(contextClose).toHaveBeenCalledOnce();
  });
});
