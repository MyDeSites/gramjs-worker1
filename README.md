# GramJS Telegram Worker

Persistent Node.js worker that listens for Telegram messages via GramJS (MTProto) and responds using AI edge functions.

## Architecture

```
Telegram User → MTProto → GramJS Worker → Supabase Edge Functions (AI) → GramJS Worker → Telegram User
```

## Quick Start

### 1. Get Telegram API Credentials

1. Go to [my.telegram.org](https://my.telegram.org)
2. Log in with your phone number
3. Go to "API development tools"
4. Create an application → get **API ID** and **API Hash**

### 2. Setup

```bash
cd gramjs-worker
npm install
cp .env.example .env
# Edit .env with your credentials
```

### 3. Authenticate (First Time)

Run the auth server to get a StringSession:

```bash
npm run auth
```

Then from another terminal (or the dashboard):

```bash
# Step 1: Send OTP
curl -X POST http://localhost:3001/send-code \
  -H "Content-Type: application/json" \
  -d '{"phone": "+60123456789"}'

# Step 2: Sign in with OTP code
curl -X POST http://localhost:3001/sign-in \
  -H "Content-Type: application/json" \
  -d '{"phone": "+60123456789", "code": "12345"}'
```

The session string is automatically saved to the database.

### 4. Start the Worker

```bash
npm run dev    # development (auto-restart)
npm start      # production (requires npm run build first)
```

### 5. Deploy to Railway

1. Push `gramjs-worker/` to a GitHub repo
2. Create a new Railway project → "Deploy from GitHub"
3. Set environment variables in Railway dashboard
4. Railway auto-detects `npm start`

**Environment variables needed:**
- `TELEGRAM_API_ID`
- `TELEGRAM_API_HASH`
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`

## How It Works

1. **Worker** connects to Telegram via GramJS using the saved StringSession
2. **Incoming text** → calls `chat-reply` edge function → AI generates response → sends reply with typing indicator
3. **Incoming photo** → downloads image → calls `analyze-screenshot` edge function → processes result
4. **Human-like delays**: Random read delay (1-3s) + typing indicator proportional to message length
5. **Health check** endpoint at `GET /health` for monitoring

## App Settings (Database)

The worker reads these keys from the `app_settings` table:

| Key | Description |
|-----|-------------|
| `TELEGRAM_SESSION_STRING` | GramJS StringSession (required) |
| `FAQ_CONTENT` | FAQ text for AI responses |
| `FAQ_LANGUAGE` | Language code (EN, RU, etc.) |
| `STOP_LIST` | Topics to block |
| `FALLBACK_REPLIES` | Replies for blocked topics |
| `ALLOWED_TOPICS` | Whitelisted topics |
| `RESPONSE_STYLE` | AI response style rules |
| `MAX_REPLY_LENGTH` | Max chars per reply (default 500) |
| `SCREENSHOT_CLARIFICATION_PROMPT` | Message when screenshot is unclear |
| `FINAL_QUALIFIED_MESSAGE` | Message when lead is qualified |
