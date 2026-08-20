import { afterEach, describe, expect, it, vi } from 'vitest';

import { getAllAudioDevices, keepLastN } from '.';

describe('keepLastN', () => {
  it.each([50, 100, 1000])(
    'should keep the last N elements of an array',
    (n) => {
      const arr = Array.from({ length: 5000 }, (_, i) => i);

      const result = keepLastN(n, arr);

      expect(result).toHaveLength(n);
      expect(result.at(0)).toBe(arr.length - n);
      expect(result.at(-1)).toBe(arr.length - 1);
    },
  );
});

describe('getAllAudioDevices', () => {
  const originalMediaDevices = Object.getOwnPropertyDescriptor(
    navigator,
    'mediaDevices',
  );

  afterEach(() => {
    if (originalMediaDevices) {
      Object.defineProperty(navigator, 'mediaDevices', originalMediaDevices);
    } else {
      Reflect.deleteProperty(navigator, 'mediaDevices');
    }
  });

  it('keeps redacted devices readable without inventing a selectable id', async () => {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        enumerateDevices: vi.fn().mockResolvedValue([
          { deviceId: '', kind: 'audioinput', label: '' },
          { deviceId: '', kind: 'audiooutput', label: '' },
        ]),
      },
    });

    await expect(getAllAudioDevices()).resolves.toEqual({
      inputDevices: [{ deviceId: '', kind: 'audioinput', label: 'Microphone' }],
      outputDevices: [{ deviceId: '', kind: 'audiooutput', label: 'Speaker' }],
    });
  });
});
