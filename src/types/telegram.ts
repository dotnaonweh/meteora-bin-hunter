export interface InlineButton {
  readonly text: string;
  readonly callback_data: string;
}

export interface InlineKeyboard {
  readonly inline_keyboard: ReadonlyArray<ReadonlyArray<InlineButton>>;
}

export interface TgChat {
  readonly id: number;
}

export interface TgMessage {
  readonly message_id: number;
  readonly chat: TgChat;
  readonly text?: string;
  readonly from?: { readonly id: number };
}

export interface TgCallbackQuery {
  readonly id: string;
  readonly data?: string;
  readonly message?: TgMessage;
  readonly from?: { readonly id: number };
}

export interface TgUpdate {
  readonly update_id: number;
  readonly message?: TgMessage;
  readonly callback_query?: TgCallbackQuery;
}

export interface TgResponse<T> {
  readonly ok: boolean;
  readonly result?: T;
  readonly description?: string;
  readonly error_code?: number;
}

/** A rendered screen: text plus an optional keyboard. Pure data — the UI layer
 *  produces these and the transport sends them, so screens are unit-testable. */
export interface Screen {
  readonly text: string;
  readonly markup?: InlineKeyboard;
}
