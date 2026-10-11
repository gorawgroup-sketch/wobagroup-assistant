export interface TelegramChat {
  id: number;
  type: string;
  first_name?: string;
  last_name?: string;
  username?: string;
}

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
}

export interface TelegramDocument {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  caption?: string;
  reply_to_message?: TelegramMessage;
  /** Nota de voz grabada con el micrófono de Telegram (ver core/telegram/voiceInput.ts). */
  voice?: {
    file_id: string;
    file_unique_id: string;
    duration: number;
    mime_type?: string;
    file_size?: number;
  };
  document?: TelegramDocument;
  /** Telegram manda varias resoluciones; la última es la más grande. */
  photo?: TelegramPhotoSize[];
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

/**
 * Marca de un update SINTÉTICO: lo crea el servidor a partir de un pedido que la persona confirmó en el front (ver
 * core/cerebro/pedidos/). Nunca llega de Telegram y el procesamiento no la lee: solo deja constancia del origen en el ledger.
 */
export interface OrigenUpdateFront {
  canal: "front";
  pedidoId: string;
  ref: string;
  /** Huella corta del dispositivo (nunca el id real). */
  dispositivo: string;
  textoHash: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
  origen?: OrigenUpdateFront;
}

export interface IncomingMessage {
  chatId: number;
  text: string;
  replyToMessageId?: number;
  replyToText?: string;
  fromUsername?: string;
  fromNombre?: string;
}

export interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}
