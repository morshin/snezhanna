'use strict';

const Anthropic = require('@anthropic-ai/sdk');

// OCR сканированного PDF через Claude — отправляем PDF-буфер напрямую как document-блок.
// Anthropic API поддерживает PDF нативно, включая сканы (встроенный OCR).
async function ocrPdf(pdfBuffer, filename = 'document.pdf') {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const response = await anthropic.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 4096,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'application/pdf',
              data: pdfBuffer.toString('base64')
            }
          },
          {
            type: 'text',
            text: `Извлеки весь текст из этого документа ("${filename}") дословно, сохраняя структуру: абзацы, таблицы, заголовки. Не добавляй комментариев — только текст документа.`
          }
        ]
      }
    ]
  });

  return response.content[0].text;
}

module.exports = { ocrPdf };
