---
description: 'Handle EVI function tool calls, return results, and render call status.'
---

# Tool calls

EVI can call functions you define, wait for your result, and continue the
conversation with it. You supply the implementation through `onToolCall`.

::: tip Tools are defined server-side
A tool call only happens if your EVI configuration defines the tool. Pass the
`configId` of a configuration that declares it when you `connect`, or nothing
will ever be called.
:::

## Handling a call

```tsx
import { useCallback } from 'react';
import { VoiceProvider, type ToolCallHandler } from '@humeai/voice-react';
import { z } from 'zod';

const weatherArgs = z.object({
  location: z.string(),
  format: z.enum(['fahrenheit', 'celsius']),
});

export function Providers({ children }: { children: React.ReactNode }) {
  const onToolCall = useCallback<ToolCallHandler>(async (toolCall, send) => {
    if (toolCall.name !== 'weather_tool') {
      return send.error({
        error: 'Tool not found',
        code: 'tool_not_found',
        level: 'warn',
        content: `The tool ${toolCall.name} is not implemented.`,
      });
    }

    // `parameters` is a JSON *string*, not an object.
    let parameters: unknown;
    try {
      parameters = JSON.parse(toolCall.parameters);
    } catch {
      return send.error({
        error: 'Invalid arguments',
        code: 'invalid_arguments',
        level: 'warn',
        content: 'The weather tool arguments were not valid JSON.',
      });
    }

    const args = weatherArgs.safeParse(parameters);
    if (!args.success) {
      return send.error({
        error: 'Invalid arguments',
        code: 'invalid_arguments',
        level: 'warn',
        content: 'The arguments did not match the weather tool schema.',
      });
    }

    const forecast = await getForecast(args.data);
    return send.success(forecast);
  }, []);

  return <VoiceProvider onToolCall={onToolCall}>{children}</VoiceProvider>;
}
```

Three things are easy to get wrong:

1. **`toolCall.parameters` is a JSON string.** Parse it, then validate the
   result — the model produced it, so treat it as untrusted input.
2. **Always return something.** Every path should end in `send.success(...)` or
   `send.error(...)`; EVI is waiting.
3. **Handle unrecognized names.** Configurations change independently of your
   code, so a name you do not implement is a normal occurrence, not a bug.

## Reporting failures

`send.error` takes four fields:

| Field     | Purpose                                   |
| --------- | ----------------------------------------- |
| `error`   | A short machine-ish label for the failure |
| `code`    | Your error code, for your own logs        |
| `level`   | Severity, for example `warn`              |
| `content` | What EVI should tell the user             |

`content` is the part the assistant may speak, so write it for a listener.

## When your handler fails anyway

If the handler throws, returns something malformed, or the result cannot be
sent, the SDK reports a `socket_error` with reason `received_tool_call_error`
through `onError`. The `ToolCallErrorSource` distinguishes the three:

| Source             | Meaning                                                          |
| ------------------ | ---------------------------------------------------------------- |
| `handler_failure`  | Your `onToolCall` threw                                          |
| `invalid_response` | It returned something that is not a valid tool response or error |
| `send_failure`     | The response could not be sent over the socket                   |

Returning `send.error(...)` yourself is always better than throwing — it lets you
control what the user hears. See [Errors and reconnection](./error-handling).

## Built-in tools

EVI also ships tools of its own, enabled through session settings rather than
through `onToolCall`:

```tsx
void connect({
  auth: { type: 'accessToken', value: accessToken },
  configId,
  sessionSettings: { builtinTools: [{ name: 'web_search' }] },
});
```

## Showing tool status in your UI

`useVoice()` exposes a `toolStatusStore` mapping each `toolCallId` to what has
happened so far — the `call` it received, and the `resolved` response or error
once one exists. That is enough to render "checking the weather…" and then a
result.

```tsx
const { toolStatusStore } = useVoice();

const pending = Object.entries(toolStatusStore).filter(
  ([, entry]) => entry.resolved === undefined,
);
```

Tool calls, responses, and errors also appear in `messages`, so you can render
them inline in a transcript instead.

## Replying outside the handler

If a tool needs something asynchronous that outlives the handler — user
confirmation, say — `sendToolMessage` sends a response or error later, given the
original `toolCallId`.

`examples/next-app/components/Voice.tsx` contains a complete, working tool; see
the [Next.js reference app](../examples/next-app).

## Reference

- [`ToolCallHandler`](/reference/api/voice-react.toolcallhandler)
- [`ToolCall`](/reference/api/voice-react.toolcall),
  [`ToolResponse`](/reference/api/voice-react.toolresponse),
  [`ToolError`](/reference/api/voice-react.toolerror)
- [`ToolCallErrorSource`](/reference/api/voice-react.toolcallerrorsource)
- [`ToolStatusStore`](/reference/api/voice-react.toolstatusstore),
  [`ToolStatusEntry`](/reference/api/voice-react.toolstatusentry)
