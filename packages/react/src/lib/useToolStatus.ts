import { useCallback, useState } from 'react';

import type { ToolCall, ToolError, ToolResponse } from '../models/messages';

/** A single tool call and the response or error that resolved it. */
export interface ToolStatusEntry {
  /** The tool call received from the assistant, if one has arrived. */
  call?: ToolCall;
  /** The response or error sent for the call, if it has been resolved. */
  resolved?: ToolResponse | ToolError;
}

/**
 * Tool calls observed during the current chat and their resolutions, keyed by
 * the tool-call ID that correlates a call with its response.
 */
export type ToolStatusStore = Record<string, ToolStatusEntry>;

/** @internal */
export const useToolStatus = () => {
  const [store, setStore] = useState<ToolStatusStore>({});

  const addToStore = useCallback(
    (message: ToolCall | ToolResponse | ToolError) => {
      setStore((prev) => {
        const entry = {
          ...prev[message.toolCallId],
        };

        if (message.type === 'tool_call') {
          entry.call = message;
        }

        if (message.type === 'tool_response' || message.type === 'tool_error') {
          entry.resolved = message;
        }

        return {
          ...prev,
          [message.toolCallId]: entry,
        };
      });
    },
    [],
  );

  const clearStore = useCallback(() => {
    setStore({});
  }, []);

  return {
    store,
    addToStore,
    clearStore,
  };
};
