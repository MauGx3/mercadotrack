import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const CONFIG_PATH = resolve(
  process.env.MT_CONFIG || new URL('../config.json', import.meta.url).pathname
);

const DEFAULTS = {
  // How often to re-check every tracked item, in minutes.
  pollMinutes: 60,
  // Random extra delay added to each poll cycle (minutes) so we don't hammer
  // Mercado Livre on a predictable clock.
  jitterMinutes: 10,
  // Polite pause between individual item fetches, in seconds.
  delayBetweenItems: [4, 9],
  // 'auto' | 'browser' | 'api'
  //   browser -> scrape the public site with a real browser (no credentials)
  //   api     -> use api.mercadolibre.com with an access token (faster, stabler)
  //   auto    -> use api when a token is configured, otherwise browser
  source: 'auto',
  // Seconds to wait for a page before giving up.
  timeoutSeconds: 60,
  // Give up on an item after this many consecutive failures.
  maxErrorStreak: 8,
  // Minimum hours between repeats of the same alert kind for the same item.
  alertCooldownHours: 12,
  notify: {
    // Fire a macOS notification banner (osascript). Great on a personal Mac.
    desktop: true,
    // Optional Telegram bot: put token + chat id here to get phone alerts.
    telegram: { enabled: false, botToken: '', chatId: '' },
  },
  // Optional Mercado Livre OAuth app credentials. Only needed for source: 'api'.
  ml: {
    clientId: '',
    clientSecret: '',
    accessToken: '',
    refreshToken: '',
    // Populated automatically after a refresh.
    tokenExpiresAt: null,
  },
  port: 4747,
};

function deepMerge(base, extra) {
  const out = { ...base };
  for (const [k, v] of Object.entries(extra ?? {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(base[k] ?? {}, v) : v;
  }
  return out;
}

function fromEnv(cfg) {
  const e = process.env;
  if (e.MT_PORT) cfg.port = Number(e.MT_PORT);
  if (e.MT_SOURCE) cfg.source = e.MT_SOURCE;
  if (e.MT_POLL_MINUTES) cfg.pollMinutes = Number(e.MT_POLL_MINUTES);
  if (e.ML_CLIENT_ID) cfg.ml.clientId = e.ML_CLIENT_ID;
  if (e.ML_CLIENT_SECRET) cfg.ml.clientSecret = e.ML_CLIENT_SECRET;
  if (e.ML_ACCESS_TOKEN) cfg.ml.accessToken = e.ML_ACCESS_TOKEN;
  if (e.ML_REFRESH_TOKEN) cfg.ml.refreshToken = e.ML_REFRESH_TOKEN;
  if (e.TELEGRAM_BOT_TOKEN) {
    cfg.notify.telegram.botToken = e.TELEGRAM_BOT_TOKEN;
    cfg.notify.telegram.enabled = true;
  }
  if (e.TELEGRAM_CHAT_ID) cfg.notify.telegram.chatId = e.TELEGRAM_CHAT_ID;
  return cfg;
}

export function loadConfig() {
  let fileCfg = {};
  if (existsSync(CONFIG_PATH)) {
    try {
      fileCfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    } catch (err) {
      console.error(`[config] ${CONFIG_PATH} is not valid JSON: ${err.message}`);
    }
  }
  return fromEnv(deepMerge(DEFAULTS, fileCfg));
}

export const config = loadConfig();

/** Persist the parts of config that change at runtime (OAuth tokens). */
export function saveConfig(patch) {
  let current = {};
  if (existsSync(CONFIG_PATH)) {
    try {
      current = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    } catch {
      current = {};
    }
  }
  writeFileSync(CONFIG_PATH, JSON.stringify(deepMerge(current, patch), null, 2) + '\n');
}
