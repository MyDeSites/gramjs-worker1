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

async function startWorker() {
  console.log("🚀 GramJS Worker starting...");

  // --- Express server (health + auth endpoints) ---
  const app = express();
  app.use(cors());
  app.use(express.json());

  // Auth endpoints (/send-code, /sign-in) — available even before Telegram connects
  setupAuthRoutes(app);

  const sessionString = await getSessionString();

  if (!sessionString) {
    console.warn(
      "⚠️ No session string found. Auth endpoints are available — use the Session Manager to connect."
    );
    // Start server without Telegram client so auth endpoints work
    app.get("/health", (_req, res) => {
      res.json({
        status: "waiting_for_session",
        connected: false,
        uptime: process.uptime(),
      });
    });

    app.listen(config.workerPort, () => {
      console.log(`🏥 Server on port ${config.workerPort} (waiting for session)`);
      console.log("   POST /send-code  — request OTP");
      console.log("   POST /sign-in    — verify OTP & save session");
    });
    return;
  }

  const settings = await getAppSettings();

  const client = new TelegramClient(
    new StringSession(sessionString),
    config.telegram.apiId,
    config.telegram.apiHash,
    {
      connectionRetries: 5,
      retryDelay: 3000,
    }
  );

  await client.connect();
  const me = await client.getMe();
  console.log(`✅ Connected as: ${(me as any).firstName || (me as any).username || me.id}`);

  // Message handler
  setupMessageHandler(client, settings);

  console.log("👂 Listening for incoming messages...");

  // Health check
  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      connected: client.connected,
      user: (me as any).username || (me as any).id,
      uptime: process.uptime(),
    });
  });

  app.listen(config.workerPort, () => {
    console.log(`🏥 Server on port ${config.workerPort}`);
    console.log("   POST /send-code  — request OTP");
    console.log("   POST /sign-in    — verify OTP & save session");
  });
}

startWorker().catch((err) => {
  console.error("💀 Worker fatal error:", err);
  process.exit(1);
});
