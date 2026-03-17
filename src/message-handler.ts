/**
 * Telegram message handler — processes incoming messages via GramJS.
 */

import { TelegramClient } from "telegram";
import { NewMessage, NewMessageEvent } from "telegram/events/index.js";
import {
  callChatReply,
  callAnalyzeScreenshot,
  getConversationHistory,
  getLeadState,
  upsertLeadState,
} from "./supabase.js";

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

export function setupMessageHandler(
  client: TelegramClient,
  settings: Record<string, string>
) {
  client.addEventHandler(async (event: NewMessageEvent) => {
    const message = event.message;
    if (!message || message.out) return;

    const chat = await message.getChat();
    if (!chat) return;

    const senderId = message.senderId?.toString() || "unknown";
    const chatId = chat.id;
    const leadId = `tg_${senderId}`;

    let dbState = await getLeadState(senderId);
    let status = dbState?.lead_status || "new";
    let finalStopSent = dbState?.final_stop_sent || false;

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
      await randomDelay(1000, 3000);

      if (hasPhoto) {
        status = "waiting_screenshot";

        const buffer = await client.downloadMedia(message, {});
        if (!buffer || !(buffer instanceof Buffer)) {
          console.log(`⚠️ [${senderId}] Could not download media`);
          return;
        }
        const base64 = buffer.toString("base64");

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
          const typingMs = Math.min(
            analysis.reply_message.length * 30 + 1000,
            8000
          );
          await simulateTyping(client, chatId as any, typingMs);
          await client.sendMessage(chatId as any, { message: analysis.reply_message });
          console.log(`📤 [${senderId}] Sent: ${analysis.reply_message.slice(0, 60)}...`);
        }

        if (analysis.new_status) status = analysis.new_status;
        if (analysis.final_stop_sent) finalStopSent = true;
        await upsertLeadState(senderId, leadId, status, finalStopSent);
      } else if (messageText) {
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
          const typingMs = Math.min(reply.reply.length * 25 + 800, 6000);
          await simulateTyping(client, chatId as any, typingMs);
          await randomDelay(300, 1200);
          await client.sendMessage(chatId as any, { message: reply.reply });
          console.log(`📤 [${senderId}] Sent: ${reply.reply.slice(0, 60)}...`);

          if (reply.new_status) status = reply.new_status;
          if (reply.final_stop_sent) finalStopSent = true;
          await upsertLeadState(senderId, leadId, status, finalStopSent);
        }
      }
    } catch (err) {
      console.error(`❌ [${senderId}] Error handling message:`, err);
    }
  }, new NewMessage({ incoming: true }));
}
