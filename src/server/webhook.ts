import { getAllSettings } from './db.js';
import {
  TELEGRAM_CHAT_ID_REGEX,
  TELEGRAM_TOKEN_REGEX,
  validateDiscordWebhookUrl,
} from './security.js';

export type WebhookEventType = 'start' | 'stop' | 'crash' | 'test' | 'info' | 'register';

const COLOR_MAP: Record<WebhookEventType, number> = {
  start: 0x22c55e,
  stop: 0xf59e0b,
  crash: 0xef4444,
  test: 0x7c3aed,
  info: 0x8b5cf6,
  register: 0x06b6d4,
};

export async function sendTelegramAlert(params: {
  title: string;
  description: string;
  fields?: Array<{ name: string; value: string }>;
}): Promise<{ sent: boolean; reason?: string }> {
  const settings = getAllSettings();
  const botToken = (settings.telegram_bot_token || '').trim();
  const chatId = (settings.telegram_chat_id || '').trim();

  if (!botToken || !chatId) {
    return { sent: false, reason: 'Telegram bot token or chat ID not configured' };
  }
  if (!TELEGRAM_TOKEN_REGEX.test(botToken)) {
    return { sent: false, reason: 'Invalid Telegram bot token format' };
  }
  if (!TELEGRAM_CHAT_ID_REGEX.test(chatId)) {
    return { sent: false, reason: 'Invalid Telegram chat ID format' };
  }

  const panelName = settings.panel_name || 'FB BAHI Panel';
  const fieldLines = (params.fields || []).map((f) => `• ${f.name}: ${f.value}`).join('\n');
  const text = [`[${panelName}] ${params.title}`, params.description, fieldLines]
    .filter(Boolean)
    .join('\n');

  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
      }),
    });
    if (!response.ok) {
      return { sent: false, reason: `Telegram HTTP ${response.status}` };
    }
    return { sent: true };
  } catch (err) {
    return { sent: false, reason: err instanceof Error ? err.message : 'Telegram request failed' };
  }
}

export async function sendDiscordAlert(params: {
  event: WebhookEventType;
  title: string;
  description: string;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
}): Promise<{ sent: boolean; reason?: string; telegramSent?: boolean }> {
  const settings = getAllSettings();
  const webhookUrl = (settings.discord_webhook_url || '').trim();

  if (params.event === 'start' && settings.webhook_on_start !== '1') {
    return { sent: false, reason: 'Start alerts disabled' };
  }
  if (params.event === 'stop' && settings.webhook_on_stop !== '1') {
    return { sent: false, reason: 'Stop alerts disabled' };
  }
  if (params.event === 'crash' && settings.webhook_on_crash !== '1') {
    return { sent: false, reason: 'Crash alerts disabled' };
  }

  let telegramSent = false;
  if (settings.telegram_bot_token && settings.telegram_chat_id) {
    const tg = await sendTelegramAlert(params);
    telegramSent = tg.sent;
  }

  if (!webhookUrl) {
    return {
      sent: telegramSent,
      telegramSent,
      reason: telegramSent ? undefined : 'No Discord or Telegram alert configured',
    };
  }

  if (!validateDiscordWebhookUrl(webhookUrl)) {
    return { sent: false, telegramSent, reason: 'Invalid Discord webhook URL' };
  }

  const panelName = settings.panel_name || 'FB BAHI Panel';

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: panelName,
        embeds: [
          {
            title: params.title,
            description: params.description,
            color: COLOR_MAP[params.event] || 0x7c3aed,
            fields: params.fields || [],
            footer: { text: `${panelName} Telemetry Alert` },
            timestamp: new Date().toISOString(),
          },
        ],
      }),
    });

    if (!response.ok) {
      return { sent: telegramSent, telegramSent, reason: `Discord HTTP ${response.status}` };
    }
    return { sent: true, telegramSent };
  } catch (err) {
    return {
      sent: telegramSent,
      telegramSent,
      reason: err instanceof Error ? err.message : 'Webhook request failed',
    };
  }
}
