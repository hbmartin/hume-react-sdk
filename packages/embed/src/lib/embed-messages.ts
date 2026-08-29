/**
                                                                         
            client                                      frame            
                                                                         
 ┌───────────────────────────┐                                           
 │       mount iframe        │ ───────────▶                              
 └───────────────────────────┘                                           
                                            ┌───────────────────────────┐
                               ◀─────────── │      iframe is ready      │
                                            └───────────────────────────┘
 ┌───────────────────────────┐                                           
 │        send config        │ ───────────▶                              
 └───────────────────────────┘                                           
                                            ┌───────────────────────────┐
                               ◀─────────── │      widget is open       │
                                            └───────────────────────────┘
                                            ┌───────────────────────────┐
                               ◀─────────── │    widget is collapsed    │
                                            └───────────────────────────┘
                                            ┌───────────────────────────┐
                               ◀─────────── │    widget is minimized    │
                                            └───────────────────────────┘
                                            ┌───────────────────────────┐
                               ◀─────────── │    transcript message     │
                                            └───────────────────────────┘
                                            ┌───────────────────────────┐
                               ◀─────────── │       resize window       │
                                            └───────────────────────────┘
 ┌───────────────────────────┐                                           
 │      unmount iframe       │ ───────────▶                              
 └───────────────────────────┘                                           
                                                                       */
import { type Hume } from 'hume';
import * as serialization from 'hume/serialization';
import { z } from 'zod';

const { AssistantMessage, UserMessage } = serialization.empathicVoice;

import { AuthStrategySchema } from './auth';

const WindowDimensionsSchema = z.object({
  width: z.number(),
  height: z.number(),
});

/** Pixel dimensions exchanged between the host page and the widget iframe. */
export type WindowDimensions = z.infer<typeof WindowDimensionsSchema>;

const SocketConnect = z.custom<Hume.empathicVoice.chat.Chat.ConnectArgs>();
/** @internal */
export type SocketConnectSchema = z.infer<typeof SocketConnect>;

const BaseSocketConfig = z.object({
  auth: AuthStrategySchema,
  hostname: z.string().optional(),
});
/** @internal */
export type SocketAuthSchema = z.infer<typeof BaseSocketConfig>;

/**
 * Authentication and connection arguments forwarded to the widget, which
 * uses them to open its own EVI socket.
 */
export type SocketConfig = SocketAuthSchema & SocketConnectSchema;

/**
 * Validates the auth/hostname portion of a `SocketConfig` while preserving the
 * (untyped-at-runtime) connect arguments that ride along with it.
 */
const SocketConfigSchema = z
  .custom<SocketConfig>()
  .superRefine((value, ctx) => {
    const result = BaseSocketConfig.safeParse(value);
    if (!result.success) {
      for (const issue of result.error.issues) {
        ctx.addIssue(issue);
      }
    }
  });

// ---------------------------------------------------------------------------
// Client to frame actions
// ---------------------------------------------------------------------------
const ClientToFrameActionSchema = z.union([
  z.object({
    type: z.literal('update_config'),
    payload: SocketConfigSchema,
  }),
  z.object({
    type: z.literal('cancel'),
  }),
  z.object({
    type: z.literal('expand_widget_from_client'),
    payload: WindowDimensionsSchema,
  }),
  z.object({
    type: z.literal('send_window_size'),
    payload: WindowDimensionsSchema,
  }),
]);

/** A message posted from the host page to the widget iframe. */
export type ClientToFrameAction = z.infer<typeof ClientToFrameActionSchema>;

export const UPDATE_CONFIG_ACTION = (config: SocketConfig) =>
  ({
    type: 'update_config',
    payload: config,
  }) satisfies ClientToFrameAction;

export const EXPAND_FROM_CLIENT_ACTION = (dimensions: WindowDimensions) =>
  ({
    type: 'expand_widget_from_client',
    payload: dimensions,
  }) satisfies ClientToFrameAction;

export const SEND_WINDOW_SIZE_ACTION = (dimensions: WindowDimensions) =>
  ({
    type: 'send_window_size',
    payload: dimensions,
  }) satisfies ClientToFrameAction;

/**
 * Parses a message sent from the host page to the widget iframe.
 *
 * Intended for widget renderers; host applications do not need it.
 *
 * @param data - Raw `MessageEvent` data to validate.
 */
export const parseClientToFrameAction = (
  data: unknown,
): Promise<ClientToFrameAction> => {
  return new Promise((resolve, reject) => {
    try {
      const value = ClientToFrameActionSchema.parse(data);
      resolve(value);
    } catch (error) {
      reject(error);
    }
  });
};

// ---------------------------------------------------------------------------
// Frame to client actions
// ---------------------------------------------------------------------------
/** @internal */
export const FrameToClientActionSchema = z.union([
  z.object({
    type: z.literal('expand_widget'),
  }),
  z.object({
    type: z.literal('collapse_widget'),
  }),
  z.object({
    type: z.literal('minimize_widget'),
  }),
  z.object({
    type: z.literal('widget_iframe_is_ready'),
  }),
  z.object({
    type: z.literal('transcript_message'),
    payload: z.custom<
      Hume.empathicVoice.UserMessage | Hume.empathicVoice.AssistantMessage
    >((val) => {
      const userMessageParseResponse = UserMessage.parse(val);
      if (userMessageParseResponse.ok) {
        return true;
      }
      const assistantMessageParseResponse = AssistantMessage.parse(val);
      if (assistantMessageParseResponse.ok) {
        return true;
      }
      return false;
    }),
  }),
  z.object({
    type: z.literal('resize_frame'),
    payload: z.object({
      width: z.number(),
      height: z.number(),
    }),
  }),
]);

/** A message posted from the widget iframe to the host page. */
export type FrameToClientAction = z.infer<typeof FrameToClientActionSchema>;

/** Message sent when the widget expands to its full size. */
export const EXPAND_WIDGET_ACTION = {
  type: 'expand_widget',
} satisfies FrameToClientAction;

/** Message sent when the widget is collapsed by the user. */
export const COLLAPSE_WIDGET_ACTION = {
  type: 'collapse_widget' as const,
} satisfies FrameToClientAction;

/** Message sent when the widget is minimized by the user. */
export const MINIMIZE_WIDGET_ACTION = {
  type: 'minimize_widget',
} satisfies FrameToClientAction;

/** Message sent once the widget iframe has loaded and can accept config. */
export const WIDGET_IFRAME_IS_READY_ACTION = {
  type: 'widget_iframe_is_ready',
} satisfies FrameToClientAction;

/** Builds the message carrying a user or assistant transcript to the host. */
export const TRANSCRIPT_MESSAGE_ACTION = (
  message: Hume.empathicVoice.UserMessage | Hume.empathicVoice.AssistantMessage,
) => {
  return {
    type: 'transcript_message',
    payload: message,
  } satisfies FrameToClientAction;
};

/** Builds the message asking the host page to resize the widget iframe. */
export const RESIZE_FRAME_ACTION = (dimensions: {
  width: number;
  height: number;
}) => {
  return {
    type: 'resize_frame',
    payload: {
      width: dimensions.width,
      height: dimensions.height,
    },
  } satisfies FrameToClientAction;
};
