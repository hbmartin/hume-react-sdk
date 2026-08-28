import z from 'zod';

const credentialSchema = (label: string) =>
  z
    .string({
      required_error: `${label} for the Hume API is required`,
      invalid_type_error: `${label} for the Hume API must be a string`,
    })
    .refine(
      (value) => value.trim().length > 0,
      `${label} for the Hume API must not be empty`,
    );

export const AuthStrategySchema = z.discriminatedUnion(
  'type',
  [
    z.object({
      type: z.literal('apiKey'),
      value: credentialSchema('API key'),
    }),
    z.object({
      type: z.literal('accessToken'),
      value: credentialSchema('Access token'),
    }),
  ],
  {
    required_error:
      'An auth strategy ({ type: "apiKey" | "accessToken", value }) is required to connect to the Hume API',
    invalid_type_error:
      'The auth strategy must be an object of the form { type: "apiKey" | "accessToken", value }',
  },
);

/**
 * Describes why `auth` cannot be used to authenticate with the Hume API.
 *
 * Returns `null` when `auth` matches the validated strategy union; otherwise a
 * human-readable message for the first problem found (for example an empty
 * API key, or a missing `type`).
 */
export const getAuthStrategyError = (auth: unknown): string | null => {
  const result = AuthStrategySchema.safeParse(auth);
  if (result.success) {
    return null;
  }
  const issue = result.error.issues[0];
  if (!issue) {
    return 'Invalid auth strategy';
  }
  return issue.path.length > 0
    ? `auth.${issue.path.join('.')}: ${issue.message}`
    : issue.message;
};
