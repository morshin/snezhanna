'use strict';

const BINARY_MAX_SIZE = 10 * 1024 * 1024; // 10 МБ — для PDF, XLSX, DOCX
const TEXT_MAX_SIZE   = 100 * 1024;        // 100 КБ — для текстовых файлов
const MAX_OUTPUT      = 15000;             // ~5000 токенов — лимит вывода для всех форматов

// Расширения, которые считаем текстовыми (даже если MIME = application/octet-stream)
const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.markdown', '.csv', '.json', '.log', '.yaml', '.yml', '.xml', '.html', '.htm']);

function isTextMime(mimeType) {
  return mimeType && (
    mimeType.startsWith('text/') ||
    mimeType === 'application/json' ||
    mimeType === 'application/xml'
  );
}

function isTextFile(mimeType, filename) {
  if (isTextMime(mimeType)) return true;
  const ext = filename ? require('path').extname(filename).toLowerCase() : '';
  return TEXT_EXTENSIONS.has(ext);
}

// Определяем реальный MIME-тип по расширению файла,
// если Gmail вернул бесполезный application/octet-stream
function resolveMimeType(mimeType, filename) {
  if (mimeType && mimeType !== 'application/octet-stream') return mimeType;
  const ext = filename ? require('path').extname(filename).toLowerCase() : '';
  const byExt = {
    '.pdf':  'application/pdf',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.xls':  'application/vnd.ms-excel',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.doc':  'application/msword',
  };
  return byExt[ext] || mimeType;
}

async function parseAttachment(buffer, mimeType, filename) {
  const resolvedMime = resolveMimeType(mimeType, filename);
  const isText = isTextFile(resolvedMime, filename);
  const maxSize = isText ? TEXT_MAX_SIZE : BINARY_MAX_SIZE;

  if (buffer.length > maxSize) {
    const sizeMb = (buffer.length / 1024 / 1024).toFixed(1);
    const limitKb = Math.round(maxSize / 1024);
    return isText
      ? `[Ошибка: текстовый файл слишком большой (${sizeMb} МБ, лимит ${limitKb} КБ). Отправь только нужный фрагмент.]`
      : `[Ошибка: файл слишком большой (${sizeMb} МБ, лимит ${Math.round(maxSize / 1024 / 1024)} МБ)]`;
  }

  let text = '';

  try {
    // Текстовые форматы — просто читаем как UTF-8
    if (isText) {
      text = buffer.toString('utf8');
    } else {
      switch (resolvedMime) {
        case 'application/pdf': {
          const pdfParse = require('pdf-parse');
          const data = await pdfParse(buffer);
          text = data.text;

          // Если pdf-parse ничего не извлёк — PDF скорее всего сканированный.
          // Запускаем OCR через pdftoppm + GPT-4o Vision.
          if (!text || !text.trim()) {
            console.log(`[PDF] Текст пустой, запускаем OCR для "${filename}"...`);
            const { ocrPdf } = require('./pdf-ocr');
            text = await ocrPdf(buffer, filename);
            console.log(`[PDF] OCR завершён, извлечено ${text.length} символов`);
          }
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
          return `[Неподдерживаемый тип вложения: ${resolvedMime} (${filename})]`;
      }
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
