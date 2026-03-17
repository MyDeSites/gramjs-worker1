import "dotenv/config";

export const config = {
  telegram: {
    apiId: parseInt(process.env.TELEGRAM_API_ID || "0"),
    apiHash: process.env.TELEGRAM_API_HASH || "",
  },
  supabase: {
    url: process.env.SUPABASE_URL || "",
    anonKey: process.env.SUPABASE_ANON_KEY || "",
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || "",
  },
  authPort: parseInt(process.env.AUTH_PORT || "3001"),
  workerPort: parseInt(process.env.WORKER_PORT || "3000"),
};
