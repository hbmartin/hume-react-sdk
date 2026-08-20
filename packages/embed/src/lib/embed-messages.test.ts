import { describe, expect, it } from 'vitest';

import {
  parseClientToFrameAction,
  UPDATE_CONFIG_ACTION,
} from './embed-messages';

describe('parseClientToFrameAction', () => {
  it('parses an update_config action and preserves connect arguments', async () => {
    const action = UPDATE_CONFIG_ACTION({
      auth: { type: 'accessToken', value: 'token' },
      hostname: 'api.hume.ai',
      configId: 'config-id',
      verboseTranscription: true,
    });

    await expect(parseClientToFrameAction(action)).resolves.toEqual({
      type: 'update_config',
      payload: {
        auth: { type: 'accessToken', value: 'token' },
        hostname: 'api.hume.ai',
        configId: 'config-id',
        verboseTranscription: true,
      },
    });
  });

  it('rejects an update_config action with an empty API key', async () => {
    const action = UPDATE_CONFIG_ACTION({
      auth: { type: 'apiKey', value: '' },
    });

    await expect(parseClientToFrameAction(action)).rejects.toMatchObject({
      issues: [
        {
          path: ['payload', 'auth', 'value'],
          message: 'API key for the Hume API must not be empty',
        },
      ],
    });
  });

  it('rejects an update_config action without auth', async () => {
    await expect(
      parseClientToFrameAction({
        type: 'update_config',
        payload: { configId: 'config-id' },
      }),
    ).rejects.toMatchObject({
      issues: [{ path: ['payload', 'auth'] }],
    });
  });

  it('rejects an unknown action type', async () => {
    await expect(
      parseClientToFrameAction({ type: 'invalid' }),
    ).rejects.toBeInstanceOf(Error);
  });
});
