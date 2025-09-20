import { createTool } from "@mastra/core/tools";
import type { IMastraLogger } from "@mastra/core/logger";
import { z } from "zod";
import { 
  upsertUser, 
  hasReachedDailyLimit, 
  saveImageGeneration 
} from "../../../server/storage";

export const deepAiImageTool = createTool({
  id: "deep-ai-image-tool",
  description: "Generate images using free DeepAI API as backup option. UNLIMITED and completely free service, no credit card required!",
  inputSchema: z.object({
    prompt: z.string().describe("Description of the image to generate (in any language)"),
    user_id: z.string().describe("Telegram user ID for tracking limits and history"),
    chat_id: z.string().describe("Telegram chat ID for context"),
    username: z.string().optional().describe("Username of the user requesting the image"),
  }),
  outputSchema: z.object({
    success: z.boolean().describe("Whether the image generation was successful"),
    image_base64: z.string().optional().describe("Base64 encoded image data for Telegram"),
    message: z.string().describe("Status message for the user"),
    daily_count: z.number().describe("User's current daily image count"),
    limit_reached: z.boolean().describe("Whether user has reached daily limit"),
  }),
  execute: async ({ context: { prompt, user_id, chat_id, username }, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info('🔧 [DeepAiImageTool] Starting backup free image generation', { 
      prompt: prompt.substring(0, 50) + "...", 
      user_id,
      chat_id,
      username
    });

    try {
      logger?.info('📝 [DeepAiImageTool] Upserting user in database');
      await upsertUser(user_id, username || `user_${user_id}`);

      logger?.info('📝 [DeepAiImageTool] Starting unlimited backup generation (no limits!)');
      // Безлимитная генерация - проверки лимитов убраны!

      // Используем бесплатный DeepAI API
      logger?.info('📝 [DeepAiImageTool] Generating image with DeepAI free service');

      const response = await fetch('https://api.deepai.org/api/text2img', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          text: `High quality, detailed, beautiful: ${prompt}`,
        }),
      });

      if (!response.ok) {
        logger?.error('❌ [DeepAiImageTool] DeepAI API error', {
          status: response.status,
          user_id
        });

        if (response.status === 429) {
          return {
            success: false,
            message: "⏱️ Достигнут лимит бесплатных запросов к резервному сервису. Попробуйте через несколько минут.",
            daily_count: 0,
            limit_reached: false
          };
        }

        return {
          success: false,
          message: "❌ Ошибка резервного сервиса генерации. Попробуйте еще раз.",
          daily_count: 0,
          limit_reached: false
        };
      }

      const result = await response.json();
      
      if (!result?.output_url) {
        logger?.error('❌ [DeepAiImageTool] No image URL in DeepAI response');
        return {
          success: false,
          message: "❌ Резервный сервис не вернул изображение. Попробуйте еще раз.",
          daily_count: 0,
          limit_reached: false
        };
      }

      // Скачиваем изображение и конвертируем в base64
      logger?.info('📝 [DeepAiImageTool] Downloading generated image');
      const imageResponse = await fetch(result.output_url);
      const imageBlob = await imageResponse.arrayBuffer();
      const imageBase64 = Buffer.from(imageBlob).toString('base64');

      logger?.info('✅ [DeepAiImageTool] Image generated successfully via backup service', { 
        imageDataLength: imageBase64.length 
      });

      // Создаем URL для сохранения в базу
      const imageUrl = `deepai://generated/${Date.now()}-${user_id}`;

      // Сохраняем запись генерации в базу данных
      logger?.info('📝 [DeepAiImageTool] Saving generation record to database');
      await saveImageGeneration(user_id, prompt, imageUrl);

      // ПРИМЕЧАНИЕ: Счетчик пользователя теперь увеличивается в workflow step2 ТОЛЬКО после успешной отправки изображения

      logger?.info('✅ [DeepAiImageTool] Free backup image generation completed successfully', {
        user_id,
        prompt: prompt.substring(0, 50) + "...",
        imageSize: imageBase64.length
      });

      return {
        success: true,
        image_base64: imageBase64,
        message: `✅ Изображение сгенерировано через резервный бесплатный сервис!`,
        daily_count: 0, // Счетчик теперь управляется в workflow step2
        limit_reached: false
      };

    } catch (error) {
      logger?.error('❌ [DeepAiImageTool] Error during backup image generation', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        user_id,
        prompt: prompt.substring(0, 50) + "..."
      });

      return {
        success: false,
        message: "❌ Ошибка при генерации, обратитесь к @dmitriy_ferixdi",
        daily_count: 0,
        limit_reached: false
      };
    }
  },
});