import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { beforeAll, describe, expect, it, vi } from 'vitest';

type WorkletPort = {
  onmessage: ((event: { data: unknown }) => void) | null;
  postMessage: ReturnType<typeof vi.fn>;
};

type WorkletProcessor = {
  port: WorkletPort;
  process: (inputs: Float32Array[][], outputs: Float32Array[][]) => boolean;
};

type WorkletProcessorConstructor = new () => WorkletProcessor;

describe('AudioStreamProcessor', () => {
  let Processor: WorkletProcessorConstructor;

  beforeAll(async () => {
    class FakeAudioWorkletProcessor {
      port: WorkletPort = {
        onmessage: null,
        postMessage: vi.fn(),
      };
    }

    const source = await readFile(
      resolve(process.cwd(), 'src/worklets/audio-worklet-20250702.js'),
      'utf8',
    );
    runInNewContext(source, {
      AudioWorkletProcessor: FakeAudioWorkletProcessor,
      Float32Array,
      registerProcessor: (
        _name: string,
        processor: WorkletProcessorConstructor,
      ) => {
        Processor = processor;
      },
      sampleRate: 48_000,
    });
  });

  it('reports the active final block before signaling an empty queue', () => {
    const processor = new Processor();
    const input = new Float32Array(128).fill(0.25);
    processor.port.onmessage?.({
      data: { type: 'audio', data: input, id: 'clip', index: 0 },
    });
    processor.port.postMessage.mockClear();

    const finalOutput = new Float32Array(128);
    expect(processor.process([], [[finalOutput]])).toBe(true);
    expect(finalOutput).toEqual(input);
    expect(processor.port.postMessage).toHaveBeenCalledWith({
      type: 'queueLength',
      length: 1,
    });

    processor.port.postMessage.mockClear();
    expect(processor.process([], [[new Float32Array(128)]])).toBe(true);
    expect(processor.port.postMessage).toHaveBeenCalledWith({
      type: 'queueLength',
      length: 0,
    });
  });
});
