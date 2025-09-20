import { createTool } from "@mastra/core/tools";
import type { IMastraLogger } from "@mastra/core/logger";
import { z } from "zod";
import { 
  upsertUser, 
  hasReachedDailyLimit, 
  saveImageGeneration,
  isAdminUser 
} from "../../../server/storage";

export const geminiImageGenerationTool = createTool({
  id: "gemini-image-generation-tool",
  description: "Generate images using Google Gemini 2.5 Flash Image Preview via hubai.loe.gg. Supports both text-to-image and image-to-image generation. Premium quality, use source_images for image-to-image generation.",
  inputSchema: z.object({
    prompt: z.string().describe("Description of the image to generate (in any language)"),
    user_id: z.string().describe("Telegram user ID for tracking"),
    chat_id: z.string().describe("Telegram chat ID for context"),
    username: z.string().optional().describe("Telegram username for display"),
    source_images: z.array(z.string()).optional().describe("URLs of source images for image-to-image generation (max 4 images)"),
  }),
  outputSchema: z.object({
    success: z.boolean().describe("Whether image generation was successful"),
    image_base64: z.string().optional().describe("Base64 encoded image data (without data URI prefix)"),
    message: z.string().describe("Status message for the user"),
    daily_count: z.number().describe("Always 0 - no limits"),
    limit_reached: z.boolean().describe("Always false - no limits"),
  }),
  execute: async ({ context: { prompt, user_id, chat_id, username, source_images }, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info('🔧 [GeminiImageGenerationTool] Starting image generation with Gemini 2.5 Flash Image Preview', { 
      prompt: prompt.substring(0, 50) + "...", 
      user_id,
      chat_id,
      username,
      source_images_count: source_images?.length || 0,
      generation_type: source_images?.length ? 'image-to-image' : 'text-to-image'
    });

    try {
      const { createOpenAI } = await import("@ai-sdk/openai");
      const { generateObject } = await import("ai");
      
      if (!process.env.HUBAI_API_KEY) {
        logger?.error('❌ [GeminiImageGenerationTool] No HUBAI_API_KEY found in environment');
        return {
          success: false,
          message: "❌ Сервис генерации изображений временно недоступен. API ключ не настроен.",
          daily_count: 0,
          limit_reached: false
        };
      }
      
      logger?.info('📝 [GeminiImageGenerationTool] Using hubai.loe.gg API');

      // Настройка hubai.loe.gg client для Gemini
      const openai = createOpenAI({
        baseURL: "https://hubai.loe.gg/v1",
        apiKey: process.env.HUBAI_API_KEY,
      });
      
      // Обеспечиваем существование пользователя в базе данных
      logger?.info('📝 [GeminiImageGenerationTool] Upserting user in database');
      await upsertUser(user_id, username || `user_${user_id}`);

      // Проверяем дневной лимит пользователя (15 изображений)
      // Админы имеют безлимитный доступ
      logger?.info('📝 [GeminiImageGenerationTool] Checking daily limits');
      const isAdmin = isAdminUser(user_id);
      const limitReached = await hasReachedDailyLimit(user_id);
      
      if (limitReached && !isAdmin) {
        logger?.warn('⚠️ [GeminiImageGenerationTool] User reached daily limit', { user_id });
        return {
          success: false,
          message: "🚫 Превышен дневной лимит генерации. Попробуйте завтра!",
          daily_count: 15,
          limit_reached: true
        };
      }
      
      if (isAdmin) {
        logger?.info('👑 [GeminiImageGenerationTool] Admin user detected - unlimited access', { user_id });
      }

      logger?.info('📝 [GeminiImageGenerationTool] Generating image with Gemini 2.5 Flash Image Preview', { 
        prompt: prompt.substring(0, 100) + "...",
        source_images_count: source_images?.length || 0
      });

      // Подготавливаем контент для multimodal генерации
      const content: any[] = [];
      
      // Добавляем исходные изображения если есть
      if (source_images && source_images.length > 0) {
        logger?.info('📝 [GeminiImageGenerationTool] Processing source images for image-to-image generation');
        
        const limitedImages = source_images.slice(0, 4); // Максимум 4 изображения
        
        for (const imageUrl of limitedImages) {
          try {
            logger?.info('📝 [GeminiImageGenerationTool] Downloading source image', { url: imageUrl });
            
            const response = await fetch(imageUrl);
            if (!response.ok) {
              logger?.warn('⚠️ [GeminiImageGenerationTool] Failed to download source image', { 
                url: imageUrl, 
                status: response.status 
              });
              continue;
            }
            
            const imageBuffer = await response.arrayBuffer();
            const base64Image = Buffer.from(imageBuffer).toString('base64');
            
            let mimeType = response.headers.get('content-type') || 'image/jpeg';
            if (!mimeType.startsWith('image/')) {
              mimeType = 'image/jpeg';
            }
            
            content.push({
              type: "image_url",
              image_url: {
                url: `data:${mimeType};base64,${base64Image}`
              }
            });
            
            logger?.info('✅ [GeminiImageGenerationTool] Successfully processed source image', { 
              url: imageUrl,
              mimeType,
              size: imageBuffer.byteLength 
            });
            
          } catch (error) {
            logger?.error('❌ [GeminiImageGenerationTool] Error processing source image', { 
              url: imageUrl, 
              error: error instanceof Error ? error.message : String(error)
            });
          }
        }
      }

      // Определяем тип генерации и инструкцию
      const isImageToImage = source_images && source_images.length > 0;
      const generationInstruction = isImageToImage 
        ? `Based on the provided source image(s), generate a new high-quality image following this description: ${prompt}. 
           Use the source image(s) as inspiration for style, composition, or content, but create a new unique image according to the prompt.
           The result should be visually appealing and maintain good composition and lighting.`
        : `Generate a high-quality image based on this description: ${prompt}. 
           Please create a detailed, visually appealing image that matches the description accurately.
           The image should be suitable for sharing and have excellent composition and lighting.`;

      // Добавляем текстовую инструкцию
      content.push({
        type: "text",
        text: `${generationInstruction} Return the result as a base64-encoded image.`
      });

      // Генерируем изображение используя multimodal approach
      const { generateText } = await import("ai");
      const result = await generateText({
        model: openai("gemini-2.5-flash-image-preview"),
        messages: [
          {
            role: "user",
            content: content
          }
        ],
        maxTokens: 4096,
        temperature: 0.8,
      });

      // Пытаемся извлечь base64 изображение из ответа
      let imageBase64 = "";
      let imageDescription = "";
      
      // Ищем base64 данные в ответе (могут быть в разных форматах)
      const base64Patterns = [
        /data:image\/[^;]+;base64,([A-Za-z0-9+/=]+)/g,
        /base64:([A-Za-z0-9+/=]+)/g,
        /([A-Za-z0-9+/=]{100,})/g  // Длинная строка base64
      ];
      
      for (const pattern of base64Patterns) {
        const match = result.text.match(pattern);
        if (match) {
          imageBase64 = match[0].includes(',') ? match[0].split(',')[1] : match[1] || match[0];
          imageDescription = isImageToImage ? 
            `Изображение создано на основе загруженного фото: ${prompt}` : 
            `Сгенерированное изображение: ${prompt}`;
          break;
        }
      }

      if (!imageBase64 || imageBase64.length < 100) {
        logger?.error('❌ [GeminiImageGenerationTool] No valid image data in response', { 
          responseLength: result.text.length,
          responseSample: result.text.substring(0, 200)
        });
        return {
          success: false,
          message: isImageToImage ? 
            "❌ Не удалось сгенерировать изображение на основе загруженного фото. Попробуйте другое изображение или описание." :
            "❌ Ошибка при генерации изображения. Попробуйте еще раз с другим описанием.",
          daily_count: 0,
          limit_reached: false
        };
      }

      logger?.info('✅ [GeminiImageGenerationTool] Image generated successfully', { 
        imageDataLength: imageBase64.length,
        description: imageDescription
      });

      // Создаем URL для сохранения в базу
      const imageUrl = `hubai://gemini-2.5-flash-image-preview/${Date.now()}-${user_id}`;

      // Сохраняем запись генерации в базу данных
      logger?.info('📝 [GeminiImageGenerationTool] Saving generation record to database');
      await saveImageGeneration(user_id, prompt, imageUrl);

      // ПРИМЕЧАНИЕ: Счетчик пользователя теперь увеличивается в workflow step2 ТОЛЬКО после успешной отправки изображения

      logger?.info('✅ [GeminiImageGenerationTool] Image generation completed successfully', {
        user_id,
        prompt: prompt.substring(0, 50) + "...",
        imageSize: imageBase64.length
      });

      const successMessage = isImageToImage ? 
        `✅ Новое изображение создано на основе вашего фото! ${imageDescription}` :
        `✅ Готово! ${imageDescription || 'Изображение сгенерировано.'}`;

      return {
        success: true,
        image_base64: imageBase64,
        message: successMessage,
        daily_count: 0, // Счетчик теперь управляется в workflow step2
        limit_reached: false
      };

    } catch (error) {
      logger?.error('❌ [GeminiImageGenerationTool] Error during image generation', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        user_id,
        prompt: prompt.substring(0, 50) + "..."
      });

      // Обработка специфических ошибок
      if (error instanceof Error) {
        const errorMessage = error.message.toLowerCase();
        
        if (errorMessage.includes('rate limit') || errorMessage.includes('quota')) {
          return {
            success: false,
            message: "⏱️ API временно перегружен. Попробуйте через несколько секунд.",
            daily_count: 0,
            limit_reached: false
          };
        }
        
        if (errorMessage.includes('content policy') || errorMessage.includes('safety')) {
          return {
            success: false,
            message: "🛡️ Ваш запрос нарушает правила безопасности. Попробуйте изменить описание.",
            daily_count: 0,
            limit_reached: false
          };
        }
        
        if (errorMessage.includes('invalid') || errorMessage.includes('unauthorized')) {
          return {
            success: false,
            message: "❌ Ошибка авторизации API. Обратитесь к администратору.",
            daily_count: 0,
            limit_reached: false
          };
        }
      }

      return {
        success: false,
        message: "❌ Ошибка при генерации, обратитесь к @dmitriy_ferixdi",
        daily_count: 0,
        limit_reached: false
      };
    }
  },
});