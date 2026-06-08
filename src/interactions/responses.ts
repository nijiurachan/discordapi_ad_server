import type { Context } from 'hono';
import { InteractionResponseType, type ModalResponse } from '../discord/types.ts';

// Discord MessageFlags.EPHEMERAL = 1 << 6
const EPHEMERAL_FLAG = 64;

export function ephemeral(
  c: Context,
  message: string,
  components?: Record<string, unknown>[],
): Response {
  return c.json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      content: message,
      flags: EPHEMERAL_FLAG,
      ...(components ? { components } : {}),
    },
  });
}

export function modalResponse(c: Context, modal: ModalResponse): Response {
  return c.json({
    type: InteractionResponseType.MODAL,
    data: modal,
  });
}

export function deferredEphemeral(c: Context): Response {
  return c.json({
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: EPHEMERAL_FLAG },
  });
}

export function updateMessage(
  c: Context,
  data: {
    content?: string;
    embeds?: Record<string, unknown>[];
    components?: Record<string, unknown>[];
  },
): Response {
  return c.json({
    type: InteractionResponseType.UPDATE_MESSAGE,
    data,
  });
}
