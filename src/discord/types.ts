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

export type Attachment = {
  id: string;
  url: string;
  proxy_url?: string;
  filename?: string;
  content_type?: string;
  size: number;
  width?: number;
  height?: number;
};

export type CommandOptionValue = string | number | boolean;

export type CommandOption = {
  name: string;
  type: number;
  value?: CommandOptionValue;
  options?: CommandOption[]; // for sub-commands and groups
};

export type ResolvedData = {
  attachments?: Record<string, Attachment>;
};

export type ApplicationCommandInteractionPayload = {
  type: typeof InteractionType.APPLICATION_COMMAND;
  id: string;
  application_id: string;
  guild_id?: string;
  channel_id?: string;
  member?: {
    user: { id: string; username?: string };
    roles?: string[];
  };
  user?: { id: string; username?: string };
  data: {
    id: string;
    name: string;
    type: number;
    options?: CommandOption[];
    resolved?: ResolvedData;
  };
};

export type ModalComponentText = {
  type: 4; // TEXT_INPUT
  custom_id: string;
  value: string;
};

export type ModalActionRow = {
  type: 1; // ACTION_ROW
  // Discord requires each Modal ACTION_ROW to contain exactly one TEXT_INPUT.
  // Encoding this at the type level catches malformed payloads at compile time.
  components: readonly [ModalComponentText];
};

export type ModalSubmitInteractionPayload = {
  type: typeof InteractionType.MODAL_SUBMIT;
  id: string;
  application_id: string;
  guild_id?: string;
  channel_id?: string;
  member?: {
    user: { id: string; username?: string };
    roles?: string[];
  };
  user?: { id: string; username?: string };
  data: {
    custom_id: string;
    components: ModalActionRow[];
  };
};

// Helper for outgoing Modal response payloads.
export type ModalResponseTextInput = {
  type: 4; // TEXT_INPUT
  custom_id: string;
  label: string;
  style: 1 | 2; // 1: SHORT, 2: PARAGRAPH
  required?: boolean;
  min_length?: number;
  max_length?: number;
  placeholder?: string;
  value?: string;
};

export type ModalResponseActionRow = {
  type: 1; // ACTION_ROW
  // Same Discord rule as ModalActionRow: one TEXT_INPUT per ACTION_ROW.
  components: readonly [ModalResponseTextInput];
};

export type ModalResponse = {
  custom_id: string;
  title: string;
  components: ModalResponseActionRow[];
};
