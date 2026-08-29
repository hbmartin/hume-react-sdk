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

/** @internal */
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
 * Credentials used to authenticate the EVI socket handshake.
 *
 * The value is sent from the browser and is therefore visible to end users.
 * Use `accessToken` with a short-lived token minted by your server in
 * production, and reserve `apiKey` for local prototyping — an API key is a
 * long-lived secret that can bill your account.
 */
export type AuthStrategy = z.infer<typeof AuthStrategySchema>;

/**
 * Describes why `auth` cannot be used to authenticate with the Hume API.
 *
 * Returns `null` when `auth` is a usable {@link AuthStrategy}; otherwise a
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
