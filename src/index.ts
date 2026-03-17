import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { NewMessage, NewMessageEvent } from "telegram/events/index.js";
import express from "express";
import cors from "cors";
import { config } from "./config.js";
import {
  getSessionString,
  getAppSettings,
  callChatReply,
  callAnalyzeScreenshot,
  getConversationHistory,
  getLeadState,
  upsertLeadState,
  upsertAppSetting,
} from "./supabase.js";
import { setupAuthRoutes } from "./auth-routes.js";
import { setupMessageHandler } from "./message-handler.js";

let telegramClient: TelegramClient | null = null;
let telegramUser: any = null;

async function connectTelegram(sessionString: string) {
  const settings = await getAppSettings();

  const client = new TelegramClient(
    new StringSession(sessionString),
    config.telegram.apiId,
    config.telegram.apiHash,
    { connectionRetries: 5, retryDelay: 3000 }
  );

  await client.connect();
  const me = await client.getMe();
  console.log(`✅ Connected as: ${(me as any).firstName || (me as any).username || me.id}`);

  setupMessageHandler(client, settings);
  console.log("👂 Listening for incoming messages...");

  telegramClient = client;
  telegramUser = me;
}

async function startWorker() {
  console.log("🚀 GramJS Worker starting...");

  const app = express();
  app.use(cors());
  app.use(express.json());

  // Auth endpoints — available even before Telegram connects
  setupAuthRoutes(app);

  // Endpoint to trigger reconnect after session is saved
  app.post("/restart-telegram", async (_req, res) => {
    try {
      if (telegramClient) {
        try { await telegramClient.disconnect(); } catch {}
        telegramClient = null;
        telegramUser = null;
      }
      const session = await getSessionString();
      if (!session) {
        return res.status(400).json({ error: "No session string found in DB" });
      }
      await connectTelegram(session);
      res.json({ status: "ok", user: (telegramUser as any)?.username || (telegramUser as any)?.id });
    } catch (err: any) {
      console.error("restart-telegram error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // Health check
  app.get("/health", (_req, res) => {
    res.json({
      status: telegramClient ? "ok" : "waiting_for_session",
      connected: telegramClient?.connected || false,
      user: telegramUser ? ((telegramUser as any).username || (telegramUser as any).id) : null,
      uptime: process.uptime(),
    });
  });

  // Try to connect on startup
  const sessionString = await getSessionString();
  if (sessionString) {
    await connectTelegram(sessionString);
  } else {
    console.warn("⚠️ No session string found — use Session Manager to connect.");
  }

  app.listen(config.workerPort, () => {
    console.log(`🏥 Server on port ${config.workerPort}`);
  });
}

startWorker().catch((err) => {
  console.error("💀 Worker fatal error:", err);
  process.exit(1);
});
