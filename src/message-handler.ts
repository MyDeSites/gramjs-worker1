/**
 * Telegram message handler — full funnel logic:
 * 1. Language detection
 * 2. Codeword check → country mapping
 * 3. If no codeword → ask country
 * 4. Intro sequence (3 messages with delays)
 * 5. AI FAQ chat (steering toward screenshots)
 * 6. Screenshot analysis → qualify/reject
 * 7. Final stop after qualification
 */

import { TelegramClient } from "telegram";
import { NewMessage, NewMessageEvent } from "telegram/events/index.js";
import {
  callChatReply,
  callAnalyzeScreenshot,
  getConversationHistory,
  getLeadState,
  upsertLeadState,
  logConversation,
  
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

function detectLanguage(text: string): string {
  // Thai characters range
  if (/[\u0E00-\u0E7F]/.test(text)) return "TH";
  // Russian / Cyrillic characters
  if (/[\u0400-\u04FF]/.test(text)) return "RU";
  // Malay indicators (common Malay words)
  const malayWords = /\b(saya|anda|boleh|terima kasih|hai|selamat|bagaimana|adakah|tidak|ya)\b/i;
  if (malayWords.test(text)) return "MS";
  return "EN";
}

function getDelaySettings(settings: Record<string, string>): {
  defaultMin: number;
  defaultMax: number;
  introMin: number;
  introMax: number;
} {
  try {
    const ds = JSON.parse(settings.DELAY_SETTINGS || "{}");
    return {
      defaultMin: ds.default_min_ms || 10000,
      defaultMax: ds.default_max_ms || 40000,
      introMin: ds.intro_min_ms || 15000,
      introMax: ds.intro_max_ms || 45000,
    };
  } catch {
    return { defaultMin: 10000, defaultMax: 40000, introMin: 15000, introMax: 45000 };
  }
}

function getCodewordMapping(settings: Record<string, string>): Record<string, string> {
  try {
    return JSON.parse(settings.CODEWORD_MAPPING || "{}");
  } catch {
    return {};
  }
}

function getIntroMessages(settings: Record<string, string>, lang: string): string[] {
  try {
    const key = `INTRO_MESSAGES_${lang}`;
    const msgs = JSON.parse(settings[key] || "[]");
    return msgs
      .sort((a: { step: number }, b: { step: number }) => a.step - b.step)
      .map((m: { message: string }) => m.message);
  } catch {
    return [];
  }
}

async function sendMessage(
  client: TelegramClient,
  chatId: bigint | string,
  text: string,
  leadId: string,
  telegramId: string,
  delayMin: number,
  delayMax: number,
  aiGenerated = false
) {
  const typingMs = Math.min(text.length * 30 + 1000, 8000);
  await simulateTyping(client, chatId as any, typingMs);
  await randomDelay(delayMin, delayMax);
  await client.sendMessage(chatId as any, { message: text });

  await logConversation({
    lead_id: leadId,
    telegram_id: telegramId,
    direction: "out",
    message_text: text,
    ai_generated: aiGenerated,
  });

  console.log(`📤 [${telegramId}] Sent: ${text.slice(0, 60)}...`);
}

export function setupMessageHandler(
  client: TelegramClient,
  settings: Record<string, string>
) {
  const delays = getDelaySettings(settings);
  const codewordMap = getCodewordMapping(settings);

  client.addEventHandler(async (event: NewMessageEvent) => {
    const message = event.message;
    if (!message || message.out) return;

    const senderId = message.senderId?.toString() || "unknown";
    const chatId = message.chatId || message.peerId;
    if (!chatId) {
      console.warn(`⚠️ [${senderId}] Missing chatId/peerId`);
      return;
    }
    const leadId = `tg_${senderId}`;
    const hasPhoto = message.photo || message.document;
    const messageText = message.text || "";

    console.log(
      `📨 [${senderId}] ${hasPhoto ? "[Photo/Document]" : messageText.slice(0, 80)}`
    );

    // Get sender info
    let senderName = "";
    let senderUsername = "";
    try {
      const sender = await message.getSender();
      if (sender && "firstName" in sender) {
        senderName = [sender.firstName, (sender as any).lastName].filter(Boolean).join(" ");
        senderUsername = (sender as any).username || "";
      }
    } catch {
      // best-effort
    }

    try {
      // 1. Get current lead state
      let dbState = await getLeadState(senderId);
      let status = dbState?.lead_status || "new";
      let finalStopSent = dbState?.final_stop_sent || false;
      let language = dbState?.language || null;
      let country = dbState?.country || null;

      // 2. Kill-switch
      if (finalStopSent) {
        console.log(`⏭️ [${senderId}] Skipping — final stop already sent`);
        return;
      }

      // 3. Detect language from message
      const detectedLang = detectLanguage(messageText);
      if (!language) language = detectedLang;

      // Log inbound message
      await logConversation({
        lead_id: leadId,
        telegram_id: senderId,
        direction: "in",
        message_text: hasPhoto ? "[Screenshot]" : messageText,
        message_type: hasPhoto ? "image" : "text",
      });

      // Update last message info
      const baseUpdate: Record<string, unknown> = {
        lead_status: status,
        final_stop_sent: finalStopSent,
        language,
        last_message_text: hasPhoto ? "[Screenshot]" : messageText.slice(0, 500),
        last_message_time: new Date().toISOString(),
        display_name: senderName || dbState?.display_name || null,
        telegram_username: senderUsername || dbState?.telegram_username || null,
      };

      // === FUNNEL LOGIC ===

      // NEW LEAD — first message
      if (status === "new" && !dbState) {
        await randomDelay(1000, 3000);

        // Check for codeword
        const upperText = messageText.toUpperCase().trim();
        let foundCodeword: string | null = null;
        let foundCountry: string | null = null;

        for (const [cw, ctry] of Object.entries(codewordMap)) {
          if (upperText.includes(cw.toUpperCase())) {
            foundCodeword = cw;
            foundCountry = ctry;
            break;
          }
        }

        if (foundCodeword && foundCountry) {
          // Codeword found → set country, send intro sequence
          console.log(`🔑 [${senderId}] Codeword "${foundCodeword}" → ${foundCountry}`);
          country = foundCountry;
          status = "intro_sent";

          await upsertLeadState(senderId, leadId, {
            ...baseUpdate,
            lead_status: "intro_sent",
            country: foundCountry,
            source_codeword: foundCodeword,
            first_contact_time: new Date().toISOString(),
          });

          // Send intro sequence
          const introMsgs = getIntroMessages(settings, language);
          for (const msg of introMsgs) {
            await sendMessage(client, chatId, msg, leadId, senderId, delays.introMin, delays.introMax);
          }

          // After intro → waiting_screenshot
          status = "waiting_screenshot";
          await upsertLeadState(senderId, leadId, {
            lead_status: "waiting_screenshot",
          });
        } else {
          // No codeword → ask country
          console.log(`❓ [${senderId}] No codeword found, asking country`);
          status = "waiting_country";

          await upsertLeadState(senderId, leadId, {
            ...baseUpdate,
            lead_status: "waiting_country",
            first_contact_time: new Date().toISOString(),
          });

          const askCountry = settings[`COUNTRY_ASK_${language}`] || settings.COUNTRY_ASK_EN || "Which country are you from?";
          await sendMessage(client, chatId, askCountry, leadId, senderId, delays.defaultMin, delays.defaultMax);
        }
        return;
      }

      // WAITING_COUNTRY — expecting country answer
      if (status === "waiting_country" && messageText) {
        await randomDelay(1000, 3000);

        // Try to detect country from message
        const lower = messageText.toLowerCase();
        const countryKeywords: Record<string, string> = {
          thailand: "Thailand", thai: "Thailand", "ประเทศไทย": "Thailand", ไทย: "Thailand",
          malaysia: "Malaysia", malay: "Malaysia",
        };

        let detectedCountry: string | null = null;
        for (const [keyword, ctry] of Object.entries(countryKeywords)) {
          if (lower.includes(keyword)) {
            detectedCountry = ctry;
            break;
          }
        }

        if (detectedCountry) {
          country = detectedCountry;
          console.log(`🌍 [${senderId}] Country detected: ${country}`);

          status = "intro_sent";
          await upsertLeadState(senderId, leadId, {
            ...baseUpdate,
            lead_status: "intro_sent",
            country,
          });

          // Send intro sequence
          const introMsgs = getIntroMessages(settings, language!);
          for (const msg of introMsgs) {
            await sendMessage(client, chatId, msg, leadId, senderId, delays.introMin, delays.introMax);
          }

          status = "waiting_screenshot";
          await upsertLeadState(senderId, leadId, {
            lead_status: "waiting_screenshot",
          });
        } else {
          // Can't determine country — ask again
          const askAgain = settings[`COUNTRY_ASK_${language}`] || "Could you please specify your country? (e.g., Thailand, Malaysia)";
          await sendMessage(client, chatId, askAgain, leadId, senderId, delays.defaultMin, delays.defaultMax);
          await upsertLeadState(senderId, leadId, baseUpdate);
        }
        return;
      }

      // PHOTO HANDLING — screenshot analysis
      if (hasPhoto && ["waiting_screenshot", "need_more_screenshots", "intro_sent", "waiting_interest"].includes(status)) {
        await randomDelay(1000, 3000);
        status = "screenshot_received";

        const buffer = await client.downloadMedia(message, {});
        if (!buffer || !(buffer instanceof Buffer)) {
          console.log(`⚠️ [${senderId}] Could not download media`);
          return;
        }
        const base64 = buffer.toString("base64");

        const clarificationPrompt = settings[`SCREENSHOT_CLARIFICATION_PROMPT_${language}`] || settings.SCREENSHOT_CLARIFICATION_PROMPT || undefined;
        const finalMsg = settings[`FINAL_QUALIFIED_MESSAGE_${language}`] || settings.FINAL_QUALIFIED_MESSAGE_EN || undefined;

        const analysis = await callAnalyzeScreenshot({
          lead_id: leadId,
          telegram_id: senderId,
          image_base64: base64,
          language: language || "EN",
          screenshot_clarification_prompt: clarificationPrompt,
          final_qualified_message: finalMsg,
        });

        console.log(
          `🔍 [${senderId}] Analysis: ${analysis.action} — ${analysis.analysis?.reasoning?.slice(0, 100)}`
        );

        if (analysis.reply_message) {
          const typingMs = Math.min(analysis.reply_message.length * 30 + 1000, 8000);
          await simulateTyping(client, chatId as any, typingMs);
          await client.sendMessage(chatId as any, { message: analysis.reply_message });
          console.log(`📤 [${senderId}] Sent: ${analysis.reply_message.slice(0, 60)}...`);
        }

        const updateData: Record<string, unknown> = {
          ...baseUpdate,
          lead_status: analysis.new_status || status,
        };

        if (analysis.analysis) {
          if (analysis.analysis.platform_detected) updateData.platform_detected = analysis.analysis.platform_detected;
          if (analysis.analysis.trip_count) updateData.trip_count_visible = analysis.analysis.trip_count;
          if (analysis.analysis.currency_visible) updateData.visible_currency = analysis.analysis.currency_visible;
        }

        if (analysis.final_stop_sent) {
          updateData.final_stop_sent = true;
          updateData.qualified_for_operator = true;
          updateData.notes_summary = analysis.analysis?.reasoning || "Qualified via screenshot analysis";
        }

        if (analysis.action === "rejected") {
          updateData.rejection_reason = analysis.analysis?.reasoning || "Screenshot did not meet criteria";
        }

        await upsertLeadState(senderId, leadId, updateData);
        return;
      }

      // TEXT MESSAGE — AI FAQ chat for active statuses
      if (messageText && ["waiting_screenshot", "need_more_screenshots", "waiting_interest", "intro_sent"].includes(status)) {
        await randomDelay(1000, 3000);

        const history = await getConversationHistory(leadId, 10);

        const reply = await callChatReply({
          lead_id: leadId,
          telegram_id: senderId,
          message_text: messageText,
          language: language || "EN",
          lead_status: status,
          final_stop_sent: finalStopSent,
          faq_content: settings.FAQ_CONTENT || "",
          stop_list: settings.STOP_LIST || "",
          fallback_replies: settings.FALLBACK_REPLIES || "",
          allowed_topics: settings.ALLOWED_TOPICS || "",
          response_style: settings.RESPONSE_STYLE || "",
          max_length: parseInt(settings.MAX_REPLY_LENGTH || "300"),
          conversation_history: history,
        });

        if (reply.skipped) {
          console.log(`⏭️ [${senderId}] Skipped: ${reply.reason}`);
          await upsertLeadState(senderId, leadId, baseUpdate);
          return;
        }

        if (reply.reply) {
          const typingMs = Math.min(reply.reply.length * 25 + 800, 6000);
          await simulateTyping(client, chatId as any, typingMs);
          await randomDelay(delays.defaultMin / 3, delays.defaultMax / 3);
          await client.sendMessage(chatId as any, { message: reply.reply });
          console.log(`📤 [${senderId}] Sent: ${reply.reply.slice(0, 60)}...`);

          if (reply.new_status) baseUpdate.lead_status = reply.new_status;
          if (reply.final_stop_sent) {
            baseUpdate.final_stop_sent = true;
          }
          await upsertLeadState(senderId, leadId, baseUpdate);
        }
        return;
      }

      // Default — just update lead state
      await upsertLeadState(senderId, leadId, baseUpdate);

    } catch (err) {
      console.error(`❌ [${senderId}] Error handling message:`, err);
    }
  }, new NewMessage({ incoming: true }));
}
