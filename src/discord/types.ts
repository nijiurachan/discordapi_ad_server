export const InteractionType = {
  PING: 1,
  APPLICATION_COMMAND: 2,
  MESSAGE_COMPONENT: 3,
  APPLICATION_COMMAND_AUTOCOMPLETE: 4,
  MODAL_SUBMIT: 5,
} as const;

export const InteractionResponseType = {
  PONG: 1,
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
  DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5,
  DEFERRED_UPDATE_MESSAGE: 6,
  UPDATE_MESSAGE: 7,
  MODAL: 9,
} as const;

export type InteractionType = (typeof InteractionType)[keyof typeof InteractionType];
export type InteractionResponseType =
  (typeof InteractionResponseType)[keyof typeof InteractionResponseType];

export type InteractionPayload = {
  type: InteractionType;
  // 後続フェーズで拡張。P1 では PING の判定だけできれば十分
};
