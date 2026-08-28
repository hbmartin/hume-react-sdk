import { describe, expect, it } from 'vitest';

import { SocketUnknownMessageError } from './errors';
import { parseMessageData } from './messages';

describe('parseMessageData', () => {
  it('parses a valid serialized subscribe event', async () => {
    await expect(
      parseMessageData(JSON.stringify({ type: 'assistant_end' })),
    ).resolves.toEqual({
      success: true,
      message: { type: 'assistant_end' },
    });
  });

  it('rejects an unknown serialized event type', async () => {
    const result = await parseMessageData(
      JSON.stringify({ type: 'not_a_subscribe_event' }),
    );

    expect(result.success).toBe(false);
    if (result.success === false) {
      expect(result.error).toBeInstanceOf(SocketUnknownMessageError);
    }
  });
});
