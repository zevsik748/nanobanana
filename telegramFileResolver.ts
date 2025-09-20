/**
 * Безопасная утилита для работы с Telegram файлами
 * Преобразует file_id в URL без логирования токенов
 */

import { IMastraLogger } from "@mastra/core/logger";

export interface TelegramFileInfo {
  fileId: string;
  url: string;
  isFileId: boolean;
}

/**
 * Проверяет является ли строка file_id или уже URL
 */
export function isFileId(input: string): boolean {
  return !input.startsWith('http') && !input.includes('/');
}

/**
 * БЕЗОПАСНО: Скачивает файл локально и возвращает base64 для использования в API без утечки токена
 */
export async function resolveFileId(fileId: string, logger?: IMastraLogger): Promise<string | null> {
  try {
    if (!process.env.TELEGRAM_BOT_TOKEN) {
      logger?.error('🔐 [TelegramFileResolver] TELEGRAM_BOT_TOKEN not found');
      return null;
    }

    logger?.info('📁 [TelegramFileResolver] Resolving file_id for local download', { fileId });
    
    // Получаем информацию о файле
    const fileResponse = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`);
    const fileData = await fileResponse.json();
    
    if (!fileData.ok || !fileData.result.file_path) {
      logger?.error('❌ [TelegramFileResolver] Failed to get file info', { 
        fileId,
        error: fileData.description || 'Unknown error'
      });
      return null;
    }

    // БЕЗОПАСНО: Скачиваем файл локально
    const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${fileData.result.file_path}`;
    const downloadResponse = await fetch(fileUrl);
    
    if (!downloadResponse.ok) {
      logger?.error('❌ [TelegramFileResolver] Failed to download file', { fileId });
      return null;
    }

    // Конвертируем в base64 для безопасного использования в API
    const arrayBuffer = await downloadResponse.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString('base64');
    
    // ИСПРАВЛЕНИЕ: определяем MIME type по сигнатуре файла, так как Telegram не всегда возвращает правильный Content-Type
    let mimeType = downloadResponse.headers.get('content-type') || '';
    
    if (!mimeType || mimeType === 'application/octet-stream') {
      // Определяем MIME type по сигнатуре файла
      const buffer = Buffer.from(arrayBuffer);
      const signature = buffer.toString('hex', 0, 4).toUpperCase();
      
      logger?.debug('🔍 [TelegramFileResolver] Detecting MIME type by file signature', {
        signature: signature,
        contentType: mimeType
      });
      
      if (signature.startsWith('FFD8FF')) {
        mimeType = 'image/jpeg';
      } else if (signature.startsWith('89504E47')) {
        mimeType = 'image/png';
      } else if (signature.startsWith('47494638')) {
        mimeType = 'image/gif';
      } else if (signature.startsWith('52494646')) {
        // RIFF format - could be WebP
        const webpSignature = buffer.toString('ascii', 8, 12);
        if (webpSignature === 'WEBP') {
          mimeType = 'image/webp';
        } else {
          mimeType = 'image/jpeg'; // fallback
        }
      } else {
        // Fallback для неизвестных форматов
        mimeType = 'image/jpeg';
      }
      
      logger?.info('✅ [TelegramFileResolver] MIME type detected by signature', {
        detectedMimeType: mimeType,
        originalContentType: downloadResponse.headers.get('content-type')
      });
    }
    
    logger?.info('✅ [TelegramFileResolver] File downloaded and converted to base64', { 
      fileId,
      size: base64.length,
      mimeType
    });
    
    // Возвращаем data URL который можно безопасно передавать в внешние API
    return `data:${mimeType};base64,${base64}`;
  } catch (error) {
    logger?.error('❌ [TelegramFileResolver] Error resolving file_id', { 
      fileId,
      error: error instanceof Error ? error.message : String(error)
    });
    return null;
  }
}

/**
 * Преобразует массив file_id или URL в массив URL
 */
export async function resolveImageUrls(inputs: string[], logger?: IMastraLogger): Promise<string[]> {
  const resolvedUrls: string[] = [];
  
  for (const input of inputs) {
    if (isFileId(input)) {
      const url = await resolveFileId(input, logger);
      if (url) {
        resolvedUrls.push(url);
      }
    } else {
      // Уже URL - добавляем как есть
      resolvedUrls.push(input);
    }
  }
  
  return resolvedUrls;
}