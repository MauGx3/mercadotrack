/**
 * Notifications. Desktop banners via osascript (macOS) and optional Telegram,
 * which is the practical way to get a price alert on your phone.
 */

import { execFile } from 'node:child_process';
import { config } from './config.mjs';

const escapeAppleScript = (s) =>
  String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ');

function desktop(title, message) {
  return new Promise((resolve) => {
    const script = `display notification "${escapeAppleScript(
      message
    )}" with title "${escapeAppleScript(title)}"`;
    execFile('osascript', ['-e', script], (err) => {
      if (err) console.warn(`[notify] desktop failed: ${err.message}`);
      resolve(!err);
    });
  });
}

async function telegram(title, message) {
  const { enabled, botToken, chatId } = config.notify.telegram;
  if (!enabled || !botToken || !chatId) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: `*${title}*\n${message}`,
        parse_mode: 'Markdown',
        disable_web_page_preview: false,
      }),
    });
    if (!res.ok) console.warn(`[notify] telegram ${res.status}: ${await res.text()}`);
    return res.ok;
  } catch (err) {
    console.warn(`[notify] telegram failed: ${err.message}`);
    return false;
  }
}

export async function notify(title, message) {
  const jobs = [];
  if (config.notify.desktop) jobs.push(desktop(title, message));
  jobs.push(telegram(title, message));
  const results = await Promise.allSettled(jobs);
  return results.some((r) => r.status === 'fulfilled' && r.value);
}
