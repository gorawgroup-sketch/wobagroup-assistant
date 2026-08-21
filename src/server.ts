import "dotenv/config";
import express, { type Request, type Response } from "express";
import { parseIncomingUpdate, sendTelegramMessage } from "../core/telegram/client";
import { askClaude } from "../core/claude/client";
import type { TelegramUpdate } from "../core/telegram/types";

const app = express();
app.use(express.json());

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok" });
});

app.post("/webhook/telegram", async (req: Request, res: Response) => {
  // Respondemos 200 de inmediato para que Telegram no reintente el update.
  res.sendStatus(200);

  const update = req.body as TelegramUpdate;
  const incoming = parseIncomingUpdate(update);

  if (!incoming) {
    return;
  }

  try {
    const reply = await askClaude(incoming.text);
    await sendTelegramMessage(incoming.chatId, reply);
  } catch (error) {
    console.error("Error procesando el mensaje de Telegram:", error);
    try {
      await sendTelegramMessage(
        incoming.chatId,
        "Lo siento, ha ocurrido un error procesando tu mensaje. Inténtalo de nuevo en unos minutos."
      );
    } catch (sendError) {
      console.error("Error enviando el mensaje de error a Telegram:", sendError);
    }
  }
});

app.listen(PORT, () => {
  console.log(`WOBA Copilot escuchando en el puerto ${PORT}`);
});
