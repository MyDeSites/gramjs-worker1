import { config } from "./config.js";

const { url, serviceRoleKey, anonKey } = config.supabase;

const headers = {
  apikey: serviceRoleKey,
  Authorization: `Bearer ${serviceRoleKey}`,
  "Content-Type": "application/json",
};

export async function getSessionString(): Promise<string | null> {
  const res = await fetch(
    `${url}/rest/v1/app_settings?key=eq.TELEGRAM_SESSION_STRING&select=value`,
    { headers }
  );
  const data = await res.json();
  return data?.[0]?.value || null;
}

export async function getAppSettings(): Promise<Record<string, string>> {
  const res = await fetch(`${url}/rest/v1/app_settings?select=key,value`, {
    headers,
  });
  const data = await res.json();
  const settings: Record<string, string> = {};
  for (const row of data || []) {
    settings[row.key] = row.value;
  }
  return settings;
}

export async function callChatReply(payload: Record<string, unknown>) {
  const res = await fetch(`${url}/functions/v1/chat-reply`, {
    method: "POST",
    headers: {
      ...headers,
      apikey: anonKey,
      Authorization: `Bearer ${anonKey}`,
    },
    body: JSON.stringify(payload),
  });
  return res.json();
}

export async function callAnalyzeScreenshot(payload: Record<string, unknown>) {
  const res = await fetch(`${url}/functions/v1/analyze-screenshot`, {
    method: "POST",
    headers: {
      ...headers,
      apikey: anonKey,
      Authorization: `Bearer ${anonKey}`,
    },
    body: JSON.stringify(payload),
  });
  return res.json();
}

export async function getConversationHistory(
  leadId: string,
  limit = 10
): Promise<Array<{ direction: string; message_text: string }>> {
  const res = await fetch(
    `${url}/rest/v1/conversation_logs?lead_id=eq.${leadId}&order=created_at.desc&limit=${limit}&select=direction,message_text`,
    { headers }
  );
  const data = await res.json();
  return (data || []).reverse();
}

export async function upsertAppSetting(
  key: string,
  value: string,
  metadata?: Record<string, unknown>
) {
  await fetch(`${url}/rest/v1/app_settings`, {
    method: "POST",
    headers: {
      ...headers,
      Prefer: "resolution=merge-duplicates",
    },
    body: JSON.stringify({ key, value, metadata: metadata || {} }),
  });
}

export interface LeadState {
  lead_status: string;
  final_stop_sent: boolean;
  language: string | null;
  country: string | null;
  source_codeword: string | null;
  display_name: string | null;
  telegram_username: string | null;
  platform_detected: string | null;
  trip_count_visible: number;
  visible_currency: string | null;
  rejection_reason: string | null;
  moderator_alert_sent: boolean;
}

export async function getLeadState(
  telegramId: string
): Promise<LeadState | null> {
  const res = await fetch(
    `${url}/rest/v1/leads?telegram_id=eq.${telegramId}&select=lead_status,final_stop_sent,language,country,source_codeword,display_name,telegram_username,platform_detected,trip_count_visible,visible_currency,rejection_reason,moderator_alert_sent`,
    { headers }
  );
  const data = await res.json();
  return data?.[0] || null;
}

export async function upsertLeadState(
  telegramId: string,
  leadId: string,
  updates: Record<string, unknown>
) {
  await fetch(`${url}/rest/v1/leads`, {
    method: "POST",
    headers: {
      ...headers,
      Prefer: "resolution=merge-duplicates",
    },
    body: JSON.stringify({
      telegram_id: telegramId,
      lead_id: leadId,
      ...updates,
    }),
  });
}

export async function logConversation(entry: {
  lead_id: string;
  telegram_id: string;
  direction: string;
  message_text: string;
  message_type?: string;
  ai_generated?: boolean;
  ai_model?: string | null;
  metadata?: Record<string, unknown>;
}) {
  await fetch(`${url}/rest/v1/conversation_logs`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      message_type: "text",
      ai_generated: false,
      ...entry,
    }),
  });
}
