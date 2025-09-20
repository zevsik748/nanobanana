import { createTool } from "@mastra/core/tools";
import type { IMastraLogger } from "@mastra/core/logger";
import { z } from "zod";
import { 
  upsertUser, 
  hasReachedDailyLimit, 
  saveImageGeneration 
} from "../../../server/storage";

export const huggingFaceImageTool = createTool({
  id: "hugging-face-image-tool",
  description: "Generate images using free Hugging Face API models like Stable Diffusion. No credit card required, UNLIMITED and completely free service!",
  inputSchema: z.object({
    prompt: z.string().describe("Description of the image to generate (in any language)"),
    user_id: z.string().describe("Telegram user ID for tracking limits and history"),
    chat_id: z.string().describe("Telegram chat ID for context"),
    username: z.string().optional().describe("Username of the user requesting the image"),
    model: z.string().default("stabilityai/stable-diffusion-2-1").describe("HuggingFace model to use"),
  }),
  outputSchema: z.object({
    success: z.boolean().describe("Whether the image generation was successful"),
    image_base64: z.string().optional().describe("Base64 encoded image data for Telegram"),
    message: z.string().describe("Status message for the user"),
    daily_count: z.number().describe("User's current daily image count"),
    limit_reached: z.boolean().describe("Whether user has reached daily limit"),
  }),
  execute: async ({ context: { prompt, user_id, chat_id, username, model }, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info('🔧 [HuggingFaceImageTool] Starting free image generation', { 
      prompt: prompt.substring(0, 50) + "...", 
      user_id,
      chat_id,
      username,
      model
    });

    try {
      logger?.info('📝 [HuggingFaceImageTool] Upserting user in database');
      await upsertUser(user_id, username || `user_${user_id}`);

      logger?.info('📝 [HuggingFaceImageTool] Starting unlimited generation (no limits!)');
      // Безлимитная генерация - проверки лимитов убраны!

      // Используем альтернативный бесплатный API через Pollinations
      const pollinationsUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=512&height=512&model=flux&nologo=true`;
      
      logger?.info('📝 [HuggingFaceImageTool] Generating image with Pollinations free service', { 
        prompt: prompt.substring(0, 100) + "..."
      });

      const response = await fetch(pollinationsUrl, {
        method: 'GET',
      });

      if (!response.ok) {
        const errorText = await response.text();
        logger?.error('❌ [HuggingFaceImageTool] HuggingFace API error', {
          status: response.status,
          error: errorText,
          user_id,
          model
        });

        // Если превышен лимит запросов
        if (response.status === 429) {
          return {
            success: false,
            message: "⏱️ Достигнут лимит бесплатных запросов. Попробуйте через несколько минут.",
            daily_count: 0,
            limit_reached: false
          };
        }

        return {
          success: false,
          message: "❌ Ошибка генерации через бесплатный сервис. Попробуйте еще раз.",
          daily_count: 0,
          limit_reached: false
        };
      }

      // Получаем изображение как blob
      const imageBlob = await response.arrayBuffer();
      
      if (!imageBlob || imageBlob.byteLength === 0) {
        logger?.error('❌ [HuggingFaceImageTool] Empty response from HuggingFace');
        return {
          success: false,
          message: "❌ Пустой ответ от сервера генерации. Попробуйте еще раз.",
          daily_count: 0,
          limit_reached: false
        };
      }

      // Конвертируем в base64
      const imageBase64 = Buffer.from(imageBlob).toString('base64');

      logger?.info('✅ [HuggingFaceImageTool] Image generated successfully', { 
        imageDataLength: imageBase64.length,
        model
      });

      // Создаем URL для сохранения в базу
      const imageUrl = `pollinations://generated/${Date.now()}-${user_id}`;

      // Сохраняем запись генерации в базу данных
      logger?.info('📝 [HuggingFaceImageTool] Saving generation record to database');
      await saveImageGeneration(user_id, prompt, imageUrl);

      // ПРИМЕЧАНИЕ: Счетчик пользователя теперь увеличивается в workflow step2 ТОЛЬКО после успешной отправки изображения

      logger?.info('✅ [HuggingFaceImageTool] Free image generation completed successfully', {
        user_id,
        prompt: prompt.substring(0, 50) + "...",
        imageSize: imageBase64.length,
        model
      });

      return {
        success: true,
        image_base64: imageBase64,
        message: `✅ Изображение сгенерировано бесплатно через AI!`,
        daily_count: 0, // Счетчик теперь управляется в workflow step2
        limit_reached: false
      };

    } catch (error) {
      logger?.error('❌ [HuggingFaceImageTool] Error during free image generation', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        user_id,
        prompt: prompt.substring(0, 50) + "...",
        model
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