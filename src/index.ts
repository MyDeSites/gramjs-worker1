import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { NewMessage, NewMessageEvent } from "telegram/events/index.js";
import express from "express";
import { config } from "./config.js";
import {
  getSessionString,
  getAppSettings,
  callChatReply,
  callAnalyzeScreenshot,
  getConversationHistory,
  getLeadState,
  upsertLeadState,
} from "./supabase.js";

// --- Helpers ---

function randomDelay(minMs: number, maxMs: number): Promise<void> {
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise((r) => setTimeout(r, ms));
}

async function simulateTyping(
  client: TelegramClient,
  chatId: bigint | string,
  durationMs: number
) {
  const { Api } = await import("telegram");
  try {
    await client.invoke(
      new Api.messages.SetTyping({
        peer: chatId as any,
        action: new Api.SendMessageTypingAction(),
      })
    );
    await new Promise((r) => setTimeout(r, durationMs));
  } catch {
    // typing indicator is best-effort
  }
}

// --- Main Worker ---

async function startWorker() {
  console.log("🚀 GramJS Worker starting...");

  const sessionString = await getSessionString();
  if (!sessionString) {
    console.error(
      "❌ No session string found in database. Use the Session Manager in the dashboard to create one, or run: npm run auth"
    );
    process.exit(1);
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

  // --- Message Handler ---

  client.addEventHandler(async (event: NewMessageEvent) => {
    const message = event.message;
    if (!message || message.out) return; // ignore outgoing messages

    const chat = await message.getChat();
    if (!chat) return;

    const senderId = message.senderId?.toString() || "unknown";
    const chatId = chat.id;
    const leadId = `tg_${senderId}`;

    // Fetch lead state from DB (source of truth)
    let dbState = await getLeadState(senderId);
    let status = dbState?.lead_status || "new";
    let finalStopSent = dbState?.final_stop_sent || false;

    // Skip if final stop already sent
    if (finalStopSent) {
      console.log(`⏭️ [${senderId}] Skipping — final stop already sent`);
      return;
    }

    const hasPhoto = message.photo || message.document;
    const messageText = message.text || "";

    console.log(
      `📨 [${senderId}] ${hasPhoto ? "[Photo/Document]" : messageText.slice(0, 80)}`
    );

    try {
      // Human-like read delay (1-3 seconds)
      await randomDelay(1000, 3000);

      if (hasPhoto) {
        // --- Screenshot Flow ---
        leadState.status = "waiting_screenshot";

        // Download image
        const buffer = await client.downloadMedia(message, {});
        if (!buffer || !(buffer instanceof Buffer)) {
          console.log(`⚠️ [${senderId}] Could not download media`);
          return;
        }
        const base64 = buffer.toString("base64");

        // Analyze screenshot
        const analysis = await callAnalyzeScreenshot({
          lead_id: leadId,
          telegram_id: senderId,
          image_base64: base64,
          language: settings.FAQ_LANGUAGE || "EN",
          screenshot_clarification_prompt:
            settings.SCREENSHOT_CLARIFICATION_PROMPT || undefined,
          final_qualified_message:
            settings.FINAL_QUALIFIED_MESSAGE || undefined,
        });

        console.log(
          `🔍 [${senderId}] Analysis: ${analysis.action} — ${analysis.analysis?.reasoning?.slice(0, 100)}`
        );

        if (analysis.reply_message) {
          // Typing simulation proportional to reply length
          const typingMs = Math.min(
            analysis.reply_message.length * 30 + 1000,
            8000
          );
          await simulateTyping(client, chatId, typingMs);

          await client.sendMessage(chatId, { message: analysis.reply_message });
          console.log(`📤 [${senderId}] Sent: ${analysis.reply_message.slice(0, 60)}...`);
        }

        // Persist lead state to DB
        if (analysis.new_status) status = analysis.new_status;
        if (analysis.final_stop_sent) finalStopSent = true;
        await upsertLeadState(senderId, leadId, status, finalStopSent);
      } else if (messageText) {
        // --- Text Chat Flow ---

        // Get conversation history for context
        const history = await getConversationHistory(leadId, 10);

        const reply = await callChatReply({
          lead_id: leadId,
          telegram_id: senderId,
          message_text: messageText,
          language: settings.FAQ_LANGUAGE || "EN",
           lead_status: status,
           final_stop_sent: finalStopSent,
          faq_content: settings.FAQ_CONTENT || "",
          stop_list: settings.STOP_LIST || "",
          fallback_replies: settings.FALLBACK_REPLIES || "",
          allowed_topics: settings.ALLOWED_TOPICS || "",
          response_style: settings.RESPONSE_STYLE || "",
          max_length: parseInt(settings.MAX_REPLY_LENGTH || "500"),
          conversation_history: history,
        });

        if (reply.skipped) {
          console.log(`⏭️ [${senderId}] Skipped: ${reply.reason}`);
          return;
        }

        if (reply.reply) {
          // Human-like typing delay
          const typingMs = Math.min(reply.reply.length * 25 + 800, 6000);
          await simulateTyping(client, chatId, typingMs);

          // Small random delay before sending (human-like)
          await randomDelay(300, 1200);

          await client.sendMessage(chatId, { message: reply.reply });
          console.log(`📤 [${senderId}] Sent: ${reply.reply.slice(0, 60)}...`);

          // Persist lead state after text reply
          if (reply.new_status) status = reply.new_status;
          if (reply.final_stop_sent) finalStopSent = true;
          await upsertLeadState(senderId, leadId, status, finalStopSent);
        }
      }
    } catch (err) {
      console.error(`❌ [${senderId}] Error handling message:`, err);
    }
  }, new NewMessage({ incoming: true }));

  console.log("👂 Listening for incoming messages...");

  // --- Health Check Server ---
  const app = express();
  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      connected: client.connected,
      user: (me as any).username || (me as any).id,
      uptime: process.uptime(),
    });
  });

  app.listen(config.workerPort, () => {
    console.log(`🏥 Health check server on port ${config.workerPort}`);
  });
}

startWorker().catch((err) => {
  console.error("💀 Worker fatal error:", err);
  process.exit(1);
});
