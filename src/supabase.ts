import { config } from "./config.js";

const { url, serviceRoleKey, anonKey } = config.supabase;

// Lightweight Supabase helpers (no SDK dependency for the worker)
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

export async function getLeadState(
  telegramId: string
): Promise<{ lead_status: string; final_stop_sent: boolean } | null> {
  const res = await fetch(
    `${url}/rest/v1/leads?telegram_id=eq.${telegramId}&select=lead_status,final_stop_sent`,
    { headers }
  );
  const data = await res.json();
  return data?.[0] || null;
}

export async function upsertLeadState(
  telegramId: string,
  leadId: string,
  leadStatus: string,
  finalStopSent: boolean
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
      lead_status: leadStatus,
      final_stop_sent: finalStopSent,
    }),
  });
}
