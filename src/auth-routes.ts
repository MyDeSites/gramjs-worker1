/**
 * Auth routes — merged into the main worker express server.
 * Handles Telegram OTP login and session string generation.
 */

import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { Express } from "express";
import { config } from "./config.js";
import { upsertAppSetting } from "./supabase.js";

// Keep one client instance per phone for the auth flow
const authClients = new Map<
  string,
  { client: TelegramClient; phoneCodeHash: string }
>();

export function setupAuthRoutes(app: Express) {
  app.post("/send-code", async (req, res) => {
    try {
      const { phone } = req.body;
      if (!phone) return res.status(400).json({ error: "phone is required" });

      const client = new TelegramClient(
        new StringSession(""),
        config.telegram.apiId,
        config.telegram.apiHash,
        { connectionRetries: 3 }
      );

      await client.connect();

      const result = await client.sendCode(
        { apiId: config.telegram.apiId, apiHash: config.telegram.apiHash },
        phone
      );

      authClients.set(phone, {
        client,
        phoneCodeHash: result.phoneCodeHash,
      });

      console.log(`📱 OTP sent to ${phone}`);
      res.json({ phone_code_hash: result.phoneCodeHash });
    } catch (err: any) {
      console.error("send-code error:", err);
      res.status(500).json({ error: err.message || "Failed to send code" });
    }
  });

  app.post("/sign-in", async (req, res) => {
    try {
      const { phone, code, phone_code_hash } = req.body;
      if (!phone || !code)
        return res.status(400).json({ error: "phone and code are required" });

      const authState = authClients.get(phone);
      if (!authState)
        return res
          .status(400)
          .json({ error: "No pending auth for this phone. Call /send-code first." });

      const { client, phoneCodeHash } = authState;
      const hash = phone_code_hash || phoneCodeHash;

      await client.invoke(
        new (await import("telegram")).Api.auth.SignIn({
          phoneNumber: phone,
          phoneCodeHash: hash,
          phoneCode: code,
        })
      );

      const sessionString = (client.session as StringSession).save();
      const me = await client.getMe();
      const displayName =
        (me as any).firstName || (me as any).username || String(me.id);

      // Auto-save to database
      await upsertAppSetting("TELEGRAM_SESSION_STRING", sessionString, {
        phone,
        display_name: displayName,
        connected_at: new Date().toISOString(),
      });

      console.log(`✅ Signed in as ${displayName}, session saved to DB`);

      // Cleanup auth client
      authClients.delete(phone);

      // Auto-trigger reconnect on the same process
      try {
        await fetch(`http://localhost:${config.workerPort}/restart-telegram`, {
          method: "POST",
        });
        console.log("🔄 Telegram reconnected with new session");
      } catch (e) {
        console.warn("⚠️ Auto-reconnect failed, manual restart may be needed");
      }

      res.json({ session_string: sessionString, display_name: displayName });
    } catch (err: any) {
      console.error("sign-in error:", err);
      res.status(500).json({ error: err.message || "Failed to sign in" });
    }
  });
}
