'use strict';

const MAX_SIZE = 10 * 1024 * 1024; // 10 MB
const MAX_OUTPUT = 15000;

async function parseAttachment(buffer, mimeType, filename) {
  if (buffer.length > MAX_SIZE) {
    return `[Ошибка: вложение слишком большое (${(buffer.length / 1024 / 1024).toFixed(1)} МБ, лимит 10 МБ)]`;
  }

  let text = '';

  try {
    switch (mimeType) {
      case 'application/pdf': {
        const pdfParse = require('pdf-parse');
        const data = await pdfParse(buffer);
        text = data.text;
        break;
      }

      case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
      case 'application/vnd.ms-excel': {
        const XLSX = require('xlsx');
        const workbook = XLSX.read(buffer, { type: 'buffer' });
        const parts = [];
        for (const sheetName of workbook.SheetNames) {
          const csv = XLSX.utils.sheet_to_csv(workbook.Sheets[sheetName]);
          parts.push(`--- ${sheetName} ---\n${csv}`);
        }
        text = parts.join('\n\n');
        break;
      }

      case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      case 'application/msword': {
        if (mimeType === 'application/msword') {
          return `[Старый формат .doc не поддерживается. Попросите отправителя сохранить как .docx]`;
        }
        const mammoth = require('mammoth');
        const result = await mammoth.extractRawText({ buffer });
        text = result.value;
        break;
      }

      default:
        return `[Неподдерживаемый тип вложения: ${mimeType} (${filename})]`;
    }
  } catch (err) {
    return `[Ошибка при чтении вложения ${filename}: ${err.message}]`;
  }

  if (!text || !text.trim()) {
    return `[Вложение ${filename} не содержит извлекаемого текста]`;
  }

  if (text.length > MAX_OUTPUT) {
    return text.slice(0, MAX_OUTPUT) + `\n\n[...обрезано, показано ${MAX_OUTPUT} из ${text.length} символов]`;
  }

  return text;
}

module.exports = { parseAttachment };
