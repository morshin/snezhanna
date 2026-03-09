'use strict';

const axios = require('axios');

/**
 * Download a photo from Telegram and return as base64.
 * @param {TelegramBot} bot - node-telegram-bot-api instance
 * @param {string} fileId - Telegram file_id
 * @param {string} botToken - bot token for building download URL
 * @returns {{ base64: string, mime_type: string }}
 */
async function downloadTelegramPhoto(bot, fileId, botToken) {
  const file = await bot.getFile(fileId);
  const fileUrl = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;
  const res = await axios.get(fileUrl, { responseType: 'arraybuffer' });
  const buffer = Buffer.from(res.data);

  // Determine mime type from file extension
  const ext = (file.file_path || '').split('.').pop().toLowerCase();
  const mimeMap = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };
  const mime_type = mimeMap[ext] || 'image/jpeg';

  return { base64: buffer.toString('base64'), mime_type };
}

/**
 * Build a Claude-compatible content array with an image block.
 * @param {string} base64 - base64-encoded image data
 * @param {string} mimeType - e.g. 'image/jpeg'
 * @param {string} [caption] - optional user caption
 * @returns {Array} content array for Claude message
 */
function buildPhotoMessage(base64, mimeType, caption) {
  const content = [
    {
      type: 'image',
      source: {
        type: 'base64',
        media_type: mimeType,
        data: base64
      }
    }
  ];
  if (caption) {
    content.push({ type: 'text', text: caption });
  }
  return content;
}

/**
 * Text placeholder for storing photo references in history (instead of base64).
 * @param {string} [caption]
 * @returns {string}
 */
function photoPlaceholder(caption) {
  return caption
    ? `[фото пользователя: ${caption}]`
    : '[фото пользователя]';
}

module.exports = { downloadTelegramPhoto, buildPhotoMessage, photoPlaceholder };
