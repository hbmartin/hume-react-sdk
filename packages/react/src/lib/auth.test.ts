import { describe, expect, it } from 'vitest';

import { AuthStrategySchema, getAuthStrategyError } from './auth';

const getParseError = (
  result: ReturnType<typeof AuthStrategySchema.safeParse>,
) => {
  if (result.success) {
    throw new Error('Expected authentication strategy parsing to fail.');
  }
  return result.error;
};

describe('AuthStrategySchema', () => {
  it('accepts an API key strategy', () => {
    expect(
      AuthStrategySchema.parse({ type: 'apiKey', value: 'hume-api-key' }),
    ).toEqual({ type: 'apiKey', value: 'hume-api-key' });
  });

  it('accepts an access token strategy', () => {
    expect(
      AuthStrategySchema.parse({ type: 'accessToken', value: 'token' }),
    ).toEqual({ type: 'accessToken', value: 'token' });
  });

  it('rejects an empty API key with a descriptive message', () => {
    const result = AuthStrategySchema.safeParse({ type: 'apiKey', value: '' });
    expect(getParseError(result).issues[0]?.message).toBe(
      'API key for the Hume API must not be empty',
    );
  });

  it('rejects a whitespace-only API key as empty', () => {
    const result = AuthStrategySchema.safeParse({
      type: 'apiKey',
      value: ' \t\n',
    });
    expect(getParseError(result).issues[0]?.message).toBe(
      'API key for the Hume API must not be empty',
    );
  });

  it('rejects a missing access token with a descriptive message', () => {
    const result = AuthStrategySchema.safeParse({ type: 'accessToken' });
    expect(getParseError(result).issues[0]?.message).toBe(
      'Access token for the Hume API is required',
    );
  });

  it('rejects an unknown strategy type', () => {
    expect(
      AuthStrategySchema.safeParse({ type: 'password', value: 'x' }).success,
    ).toBe(false);
  });
});

describe('getAuthStrategyError', () => {
  it('returns null for a usable strategy', () => {
    expect(getAuthStrategyError({ type: 'apiKey', value: 'k' })).toBeNull();
    expect(
      getAuthStrategyError({ type: 'accessToken', value: 't' }),
    ).toBeNull();
  });

  it('describes an empty credential with its path', () => {
    expect(getAuthStrategyError({ type: 'apiKey', value: '' })).toBe(
      'auth.value: API key for the Hume API must not be empty',
    );
    expect(getAuthStrategyError({ type: 'accessToken', value: 42 })).toBe(
      'auth.value: Access token for the Hume API must be a string',
    );
    expect(getAuthStrategyError({ type: 'accessToken', value: '   ' })).toBe(
      'auth.value: Access token for the Hume API must not be empty',
    );
  });

  it('explains a missing or malformed strategy', () => {
    expect(getAuthStrategyError(undefined)).toBe(
      'An auth strategy ({ type: "apiKey" | "accessToken", value }) is required to connect to the Hume API',
    );
    expect(getAuthStrategyError('hume-api-key')).toBe(
      'The auth strategy must be an object of the form { type: "apiKey" | "accessToken", value }',
    );
    expect(getAuthStrategyError({ value: 'k' })).toMatch(
      /^auth\.type: Invalid discriminator value/,
    );
  });
});
