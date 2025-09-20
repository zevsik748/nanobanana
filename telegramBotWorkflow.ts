import { createWorkflow, createStep } from "../inngest";
import { z } from "zod";
import { generateImageWithHubaiGemini } from "../utils/hubaiGeminiGenerator";
import { reserveGenerationSlot, releaseReservedSlot } from "../utils/userLimits";
import { incrementUserImageCount } from "../../../server/storage";

// Step 1: Process message and generate image using Gemini 2.5 Flash Image Preview  
const step1 = createStep({
  id: "process-message",
  description: "Process user message and generate image using Gemini 2.5 Flash Image Preview",
  inputSchema: z.object({
    message: z.string().describe("The message text from the user"),
    fileIds: z.array(z.string()).optional().describe("Array of Telegram file_id if any"),
    chatId: z.string().describe("Telegram chat ID"),
    userId: z.string().describe("Telegram user ID for rate limiting"),
    userName: z.string().optional().describe("Username of the sender"),
    messageId: z.string().optional().describe("Message ID for reply reference"),
    threadId: z.string().describe("Thread ID for conversation context"),
    chatType: z.string().optional().default("private").describe("Chat type: private, group, supergroup, channel"),
  }),
  outputSchema: z.object({
    response: z.string().describe("The response message"),
    imagePath: z.string().nullable().optional().describe("Path to generated image file"),
    chatId: z.string().describe("Chat ID to send response to"),
    messageId: z.string().optional().describe("Original message ID for reply"),
    success: z.boolean().describe("Whether generation was successful"),
    imageSent: z.boolean().optional().describe("Whether image was already sent directly from step1"),
    userId: z.string().describe("User ID for limit tracking"),
    // Note: Removed showModeButtons - no longer needed without mode selection
  }),
  execute: async ({ inputData, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info('🔧 [Step1] Processing message for Gemini 2.5 Flash Image Preview', {
      messageLength: inputData.message.length,
      imageCount: inputData.fileIds?.length || 0,
      chatId: inputData.chatId,
      userId: inputData.userId
    });

    // Объявляем переменную здесь для доступа в catch блоке
    let slotReservation: any;

    try {
      // Приветственное сообщение при старте
      if (inputData.message === "/start") {
        logger?.info('🔧 [Step1] Sending greeting message');
        return {
          response: "Привет. Это режим генерации Nano Banano. Скажи чё надо, сгенерирую.",
          chatId: inputData.chatId,
          messageId: inputData.messageId,
          success: true,
          imageSent: false,
          userId: inputData.userId,
        };
      }

      // Note: Removed keyword filtering - users can now send any text or photos directly for generation
      
      // Проверяем фото без текста - нужно спросить что делать
      if (inputData.fileIds && inputData.fileIds.length > 0 && (!inputData.message || inputData.message.trim().length === 0)) {
        logger?.info('🖼️ [Step1] Photos without text detected', {
          photoCount: inputData.fileIds.length,
          messageLength: inputData.message?.length || 0
        });
        
        const photoCount = inputData.fileIds.length;
        const responseText = photoCount === 1 
          ? "Что хочешь сделать с этой фоткой?" 
          : "Что хочешь сделать с этими фотками?";
        
        return {
          response: responseText,
          chatId: inputData.chatId,
          messageId: inputData.messageId,
          success: true,
          imageSent: false,
          userId: inputData.userId,
        };
      }

      // Атомарное резервирование слота для генерации (5 запросов в день)
      logger?.info('🎯 [Step1] Reserving generation slot', {
        userId: inputData.userId,
        userName: inputData.userName
      });

      slotReservation = await reserveGenerationSlot(
        inputData.userId,
        inputData.userName || "Unknown",
        inputData.chatType || "private"
      );

      if (!slotReservation.canGenerate) {
        logger?.info('❌ [Step1] Failed to reserve slot - limit exceeded', {
          userId: inputData.userId,
          dailyCount: slotReservation.dailyCount,
          limitReached: slotReservation.limitReached,
          chatType: inputData.chatType
        });

        // Разные сообщения для разных типов чатов
        const isGroupChat = inputData.chatType === "group" || inputData.chatType === "supergroup";
        const limitMessage = isGroupChat 
          ? "🚫 Лимит запросов для чата по генерации изображений Nano Banano закончился (30/30). Лимиты обновляются каждые сутки в 00:00 МСК."
          : "Ваш лимит на сегодня закончен: 3/3. Приходите завтра. Хочешь безлимит? Пиши @dmitriy_ferixdi";

        return {
          response: limitMessage,
          chatId: inputData.chatId,
          messageId: inputData.messageId,
          success: false,
          userId: inputData.userId,
        };
      }

      logger?.info('✅ [Step1] Generation slot reserved', {
        userId: inputData.userId,
        dailyCount: slotReservation.dailyCount,
        remaining: slotReservation.remaining,
        isAdmin: slotReservation.isAdmin
      });

      // Вызов правильного Hubai Gemini генератора (через Google SDK)
      logger?.info('🔧 [Step1] Calling Hubai Gemini generator with Google SDK', {
        prompt: inputData.message.substring(0, 50) + "...",
        hasImages: !!(inputData.fileIds && inputData.fileIds.length > 0)
      });

      let result;
      try {
        logger?.info('🔧 [Step1] About to call generateImageWithHubaiGemini', {
          prompt: inputData.message.substring(0, 50) + "...",
          imageCount: inputData.fileIds?.length || 0,
          fileIds: inputData.fileIds ? inputData.fileIds.map(f => f.substring(0, 15) + '...') : []
        });
        
        result = await generateImageWithHubaiGemini({
          prompt: inputData.message,
          model: 'gemini-2.5-flash-image-preview', // Nano Banana модель
          sourceImages: inputData.fileIds,
        }, logger); // ← ПЕРЕДАЕМ ЛОГГЕР!
        
      } catch (error) {
        logger?.error('❌ [Step1] Exception in generateImageWithHubaiGemini', {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined
        });
        
        result = {
          success: false,
          error: `Exception in generateImageWithHubaiGemini: ${error instanceof Error ? error.message : String(error)}`
        };
      }

      logger?.info('✅ [Step1] Generation completed', { 
        success: result.success,
        hasImage: !!result.imageBase64,
        description: result.description
      });

      // Если генерация неудачная - возвращаем зарезервированный слот
      if (!result.success && !slotReservation.isAdmin) {
        logger?.info('↩️ [Step1] Releasing reserved slot due to generation failure');
        await releaseReservedSlot(inputData.userId);
      }

      // Если генерация успешная - отправляем изображение СРАЗУ (без передачи base64 между шагами)
      if (result.success && result.imageBase64) {
        logger?.info('✅ [Step1] Image generated successfully, saving to temporary file');
        
        // АРХИТЕКТУРНО ПРАВИЛЬНОЕ РЕШЕНИЕ: сохраняем изображение во временный файл
        try {
          const crypto = require('crypto');
          const fs = require('fs');
          const path = require('path');
          
          // Генерируем уникальное имя файла
          const imageId = crypto.randomUUID();
          const tempFilePath = path.join('/tmp', `nano_banana_${imageId}.jpg`);
          
          // Сохраняем изображение как файл
          const imageBuffer = Buffer.from(result.imageBase64, 'base64');
          fs.writeFileSync(tempFilePath, imageBuffer);
          
          logger?.info('✅ [Step1] Image saved to temporary file', {
            tempFilePath,
            imageSize: imageBuffer.length,
            chatId: inputData.chatId
          });

          // Возвращаем путь к файлу вместо base64 данных
          return {
            response: result.description || "🍌 Изображение готово!",
            imagePath: tempFilePath, // Передаем путь к файлу вместо base64!
            chatId: inputData.chatId,
            messageId: inputData.messageId,
            success: true,
            imageSent: false, // Step2 будет отправлять
            userId: inputData.userId,
          };

        } catch (fileError) {
          logger?.error('❌ [Step1] Failed to save image to temp file', {
            error: fileError instanceof Error ? fileError.message : String(fileError),
            chatId: inputData.chatId
          });
          
          // Fallback: возвращаем base64 если не удалось сохранить в файл
          logger?.warn('⚠️ [Step1] Falling back to base64 transfer (may cause output_too_large)');
          return {
            response: result.description || "🍌 Изображение готово!",
            imagePath: result.imageBase64, // Возвращаем base64 как fallback
            chatId: inputData.chatId,
            messageId: inputData.messageId,
            success: true,
            imageSent: false,
            userId: inputData.userId,
          };
        }
      }

      // Обработка неудачной генерации
      let responseMessage = "";
      if (!result.success) {
        // При неудачной генерации показываем восстановленный лимит
        const currentRemaining = slotReservation.isAdmin 
          ? 999 
          : Math.min(slotReservation.remaining + 1, 5); // +1 потому что слот был возвращен
        const limitInfo = slotReservation.isAdmin 
          ? "" 
          : `\n\n📊 Осталось попыток сегодня: ${currentRemaining}/5`;
        responseMessage = (result.error || "❌ Nano Banana не смог сгенерировать изображение. Попробуйте другое описание!") + limitInfo;
      } else {
        responseMessage = "❌ Изображение не было сгенерировано.";
      }

      return {
        response: responseMessage,
        imagePath: null, // НЕ передаем base64!
        chatId: inputData.chatId,
        messageId: inputData.messageId,
        success: result.success,
        userId: inputData.userId,
      };
      
    } catch (error) {
      logger?.error('❌ [Step1] Error in generation processing', {
        error: error instanceof Error ? error.message : String(error),
        userId: inputData.userId
      });
      
      // КРИТИЧЕСКИ ВАЖНО: возвращаем зарезервированный слот при любом исключении
      if (typeof slotReservation !== 'undefined' && slotReservation?.canGenerate && !slotReservation?.isAdmin) {
        logger?.info('↩️ [Step1] Releasing reserved slot due to unexpected error');
        try {
          await releaseReservedSlot(inputData.userId);
        } catch (releaseError) {
          logger?.error('❌ [Step1] Failed to release reserved slot', {
            releaseError: releaseError instanceof Error ? releaseError.message : String(releaseError),
            userId: inputData.userId
          });
        }
      }
      
      return {
        response: "❌ Ошибка при генерации, обратитесь к @dmitriy_ferixdi",
        chatId: inputData.chatId,
        messageId: inputData.messageId,
        success: false,
        imageSent: false,
        userId: inputData.userId,
      };
    }
  }
});

// Step 2: Send the response back to Telegram
const step2 = createStep({
  id: "send-telegram-response",
  description: "Send the response (with optional image) back to the Telegram chat",
  inputSchema: z.object({
    response: z.string().describe("The response message"),
    imagePath: z.string().nullable().optional().describe("Path to generated image file"),
    chatId: z.string().describe("Chat ID to send response to"),
    messageId: z.string().optional().describe("Original message ID for reply"),
    success: z.boolean().describe("Whether generation was successful"),
    imageSent: z.boolean().optional().describe("Whether image was already sent directly from step1"),
    userId: z.string().describe("User ID for limit tracking"),
  }),
  outputSchema: z.object({
    success: z.boolean().describe("Whether the message was sent successfully"),
    sentMessageId: z.string().optional().describe("ID of the sent message"),
  }),
  execute: async ({ inputData, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info('🔧 [Step2] Sending response to Telegram', {
      chatId: inputData.chatId,
      responseLength: inputData.response.length,
      hasImage: !!inputData.imagePath,
      imageSent: !!inputData.imageSent
    });

    try {
      if (!process.env.TELEGRAM_BOT_TOKEN) {
        throw new Error("TELEGRAM_BOT_TOKEN not found in environment variables");
      }

      const telegramApiUrl = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;
      
      // Если есть изображение (либо как base64 либо как путь к файлу), отправляем его как фото
      if (inputData.imagePath) {
        logger?.info('🔧 [Step2] Sending image response');
        
        let imageBuffer: Buffer;
        
        // Проверяем, является ли imagePath путем к файлу или base64 данными
        if (inputData.imagePath.startsWith('/tmp/')) {
          // Читаем изображение из временного файла
          const fs = require('fs');
          logger?.info('📁 [Step2] Reading image from temporary file', {
            filePath: inputData.imagePath
          });
          
          imageBuffer = fs.readFileSync(inputData.imagePath);
          
          // Удаляем временный файл после чтения
          try {
            fs.unlinkSync(inputData.imagePath);
            logger?.info('🗑️ [Step2] Temporary file deleted', {
              filePath: inputData.imagePath
            });
          } catch (deleteError) {
            logger?.warn('⚠️ [Step2] Failed to delete temporary file', {
              filePath: inputData.imagePath,
              error: deleteError instanceof Error ? deleteError.message : String(deleteError)
            });
          }
        } else {
          // Конвертируем base64 в buffer (fallback)
          logger?.info('📝 [Step2] Converting base64 to buffer');
          imageBuffer = Buffer.from(inputData.imagePath, 'base64');
        }
        
        // Создаем FormData для отправки изображения
        const formData = new FormData();
        formData.append('chat_id', inputData.chatId);
        // НЕ добавляем caption и parse_mode - отправляем только изображение
        
        // Добавляем файл изображения
        // Преобразуем Buffer в Uint8Array для совместимости с Blob
        const uint8Array = new Uint8Array(imageBuffer);
        const blob = new Blob([uint8Array], { type: 'image/jpeg' });
        formData.append('photo', blob, 'generated_image.jpg');
        
        if (inputData.messageId) {
          formData.append('reply_parameters', JSON.stringify({
            message_id: parseInt(inputData.messageId)
          }));
        }

        const response = await fetch(`${telegramApiUrl}/sendPhoto`, {
          method: 'POST',
          body: formData,
        });

        const result = await response.json();

        if (!response.ok) {
          throw new Error(`Telegram API error: ${result.description || 'Unknown error'}`);
        }

        logger?.info('✅ [Step2] Image sent to Telegram', {
          success: true,
          messageId: result.result?.message_id,
          chatId: inputData.chatId
        });

        // КРИТИЧЕСКИ ВАЖНО: Увеличиваем счетчик ТОЛЬКО после успешной отправки изображения пользователю!
        try {
          logger?.info('📈 [Step2] Incrementing user image count after successful delivery', { userId: inputData.userId });
          await incrementUserImageCount(inputData.userId);
          logger?.info('✅ [Step2] User image count incremented successfully');
        } catch (countError) {
          logger?.error('❌ [Step2] Failed to increment user count', {
            userId: inputData.userId,
            error: countError instanceof Error ? countError.message : String(countError)
          });
          // Не прерываем процесс, если инкремент не удался - изображение уже доставлено
        }

        // Пересылаем все генерации в мониторинговый чат администратора
        try {
          const adminChatId = "6913446846"; // dmitriy_ferixdi
          if (inputData.chatId !== adminChatId) {
            logger?.info('📤 [Step2] Forwarding generation to admin chat');
            
            // Отправляем информацию о пользователе и изображение в админский чат
            await fetch(`${telegramApiUrl}/forwardMessage`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                chat_id: adminChatId,
                from_chat_id: inputData.chatId,
                message_id: result.result?.message_id
              })
            });
            
            logger?.info('✅ [Step2] Generation forwarded to admin chat');
          }
        } catch (forwardError) {
          logger?.warn('⚠️ [Step2] Failed to forward to admin chat', {
            error: forwardError instanceof Error ? forwardError.message : String(forwardError)
          });
          // Не прерываем основной процесс если пересылка не удалась
        }

        return {
          success: true,
          sentMessageId: result.result?.message_id?.toString(),
        };
      }
      // Если нет изображения, отправляем обычное текстовое сообщение
      else {
        logger?.info('🔧 [Step2] Sending text response');
        
        const payload: any = {
          chat_id: inputData.chatId,
          text: inputData.response,
          parse_mode: 'HTML',
        };

        if (inputData.messageId) {
          payload.reply_parameters = {
            message_id: parseInt(inputData.messageId)
          };
        }

        const response = await fetch(`${telegramApiUrl}/sendMessage`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        });

        const result = await response.json();

        if (!response.ok) {
          throw new Error(`Telegram API error: ${result.description || 'Unknown error'}`);
        }

        logger?.info('✅ [Step2] Text message sent to Telegram', {
          success: true,
          messageId: result.result?.message_id,
          chatId: inputData.chatId
        });

        return {
          success: true,
          sentMessageId: result.result?.message_id?.toString(),
        };
      }

    } catch (error) {
      logger?.error('❌ [Step2] Error sending message', { 
        error: error instanceof Error ? error.message : String(error),
        chatId: inputData.chatId
      });
      
      return {
        success: false,
        sentMessageId: undefined,
      };
    }
  }
});

// Create the workflow with exactly 2 steps
export const telegramBotWorkflow = createWorkflow({
  id: "telegram-multimodal-bot",
  description: "Simple Telegram bot using Gemini 2.5 Flash Image Preview for image generation",
  inputSchema: z.object({
    message: z.string().describe("The message text from the user"),
    fileIds: z.array(z.string()).optional().describe("Array of Telegram file_id if any"),
    chatId: z.string().describe("Telegram chat ID"),
    userId: z.string().describe("Telegram user ID for rate limiting"),
    userName: z.string().optional().describe("Username of the sender"),
    messageId: z.string().optional().describe("Message ID for reply reference"),
    threadId: z.string().describe("Thread ID for conversation context"),
    chatType: z.string().optional().default("private").describe("Chat type: private, group, supergroup, channel"),
  }),
  outputSchema: z.object({
    success: z.boolean().describe("Whether the message was sent successfully"),
    sentMessageId: z.string().optional().describe("ID of the sent message"),
  }),
})
  .then(step1 as any)
  .then(step2 as any)
  .commit();