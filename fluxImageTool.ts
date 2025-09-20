import { createTool } from "@mastra/core/tools";
import type { IMastraLogger } from "@mastra/core/logger";
import { z } from "zod";
import { 
  upsertUser, 
  hasReachedDailyLimit, 
  saveImageGeneration 
} from "../../../server/storage";

export const fluxImageTool = createTool({
  id: "flux-image-tool",
  description: "Generate high-quality images using FLUX.1-dev model through multiple free endpoints. Premium quality comparable to Nano Banano, UNLIMITED and completely free!",
  inputSchema: z.object({
    prompt: z.string().describe("Description of the image to generate (in any language)"),
    user_id: z.string().describe("Telegram user ID for tracking limits and history"),
    chat_id: z.string().describe("Telegram chat ID for context"),
    username: z.string().optional().describe("Username of the user requesting the image"),
    style: z.string().default("photorealistic").describe("Image style: photorealistic, artistic, anime, digital-art"),
  }),
  outputSchema: z.object({
    success: z.boolean().describe("Whether the image generation was successful"),
    image_base64: z.string().optional().describe("Base64 encoded image data for Telegram"),
    message: z.string().describe("Status message for the user"),
    daily_count: z.number().describe("User's current daily image count"),
    limit_reached: z.boolean().describe("Whether user has reached daily limit"),
  }),
  execute: async ({ context: { prompt, user_id, chat_id, username, style }, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info('🔧 [FluxImageTool] Starting premium quality image generation', { 
      prompt: prompt.substring(0, 50) + "...", 
      user_id,
      chat_id,
      username,
      style
    });

    try {
      logger?.info('📝 [FluxImageTool] Upserting user in database');
      await upsertUser(user_id, username || `user_${user_id}`);

      logger?.info('📝 [FluxImageTool] Starting unlimited image generation (no limits!)');
      // Безлимитная генерация - проверки лимитов убраны!

      // Список бесплатных high-quality endpoints для FLUX
      const endpoints = [
        {
          name: "Pollinations FLUX",
          url: `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=1024&model=flux&seed=${Math.floor(Math.random() * 1000000)}&nologo=true`,
          method: 'GET'
        },
        {
          name: "PerplexityLabs FLUX", 
          url: `https://labs-api.perplexity.ai/generate-image`,
          method: 'POST',
          body: {
            prompt: `${style} style: ${prompt}`,
            model: "flux-1-dev",
            width: 1024,
            height: 1024
          }
        },
        {
          name: "Replicate Mirror",
          url: `https://api.replicate.com/v1/predictions`,
          method: 'POST',
          body: {
            version: "flux-1-dev-fp8",
            input: {
              prompt: `High quality ${style}: ${prompt}`,
              width: 1024,
              height: 1024,
              num_inference_steps: 30,
              guidance_scale: 7.5
            }
          }
        }
      ];

      let lastError = null;

      // Пробуем каждый endpoint
      for (const endpoint of endpoints) {
        try {
          logger?.info('📝 [FluxImageTool] Trying endpoint', { 
            name: endpoint.name,
            prompt: prompt.substring(0, 100) + "..."
          });

          let response;
          if (endpoint.method === 'GET') {
            response = await fetch(endpoint.url, {
              method: 'GET',
              headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
              }
            });
          } else {
            response = await fetch(endpoint.url, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
              },
              body: JSON.stringify(endpoint.body)
            });
          }

          if (response.ok) {
            const contentType = response.headers.get('content-type');
            
            if (contentType && contentType.startsWith('image/')) {
              // Прямое изображение
              const imageBlob = await response.arrayBuffer();
              const imageBase64 = Buffer.from(imageBlob).toString('base64');

              if (imageBase64 && imageBlob.byteLength > 1000) {
                logger?.info('✅ [FluxImageTool] High-quality image generated successfully', { 
                  endpoint: endpoint.name,
                  imageDataLength: imageBase64.length 
                });

                // Создаем URL для сохранения в базу
                const imageUrl = `flux://${endpoint.name}/${Date.now()}-${user_id}`;

                // Сохраняем запись генерации в базу данных
                logger?.info('📝 [FluxImageTool] Saving generation record to database');
                await saveImageGeneration(user_id, prompt, imageUrl);

                // Увеличиваем дневной счетчик пользователя
                // ПРИМЕЧАНИЕ: Счетчик пользователя теперь увеличивается в workflow step2 ТОЛЬКО после успешной отправки изображения

                logger?.info('✅ [FluxImageTool] Premium image generation completed successfully', {
                  user_id,
                  prompt: prompt.substring(0, 50) + "...",
                  imageSize: imageBase64.length,
                  endpoint: endpoint.name
                });

                return {
                  success: true,
                  image_base64: imageBase64,
                  message: `✨ Изображение сгенерировано в премиум качестве! Сервис: ${endpoint.name}`,
                  daily_count: 0, // Счетчик теперь управляется в workflow step2
                  limit_reached: false
                };
              }
            } else {
              // JSON ответ с URL или base64
              const result = await response.json();
              if (result.image_url || result.output || result.url) {
                const imageUrl = result.image_url || result.output || result.url;
                
                // Скачиваем изображение
                const imageResponse = await fetch(imageUrl);
                if (imageResponse.ok) {
                  const imageBlob = await imageResponse.arrayBuffer();
                  const imageBase64 = Buffer.from(imageBlob).toString('base64');
                  
                  if (imageBase64 && imageBlob.byteLength > 1000) {
                    logger?.info('✅ [FluxImageTool] High-quality image downloaded successfully', { 
                      endpoint: endpoint.name,
                      imageDataLength: imageBase64.length 
                    });

                    const dbImageUrl = `flux://${endpoint.name}/${Date.now()}-${user_id}`;
                    await saveImageGeneration(user_id, prompt, dbImageUrl);
                    // ПРИМЕЧАНИЕ: Счетчик пользователя теперь увеличивается в workflow step2 ТОЛЬКО после успешной отправки изображения

                    return {
                      success: true,
                      image_base64: imageBase64,
                      message: `✨ Изображение сгенерировано в премиум качестве! Сервис: ${endpoint.name}`,
                      daily_count: 0, // Счетчик теперь управляется в workflow step2
                      limit_reached: false
                    };
                  }
                }
              }
            }
          }
          
          lastError = `${endpoint.name}: ${response.status} ${response.statusText}`;
          logger?.warn('⚠️ [FluxImageTool] Endpoint failed, trying next', { 
            endpoint: endpoint.name,
            status: response.status 
          });

        } catch (error) {
          lastError = `${endpoint.name}: ${error instanceof Error ? error.message : String(error)}`;
          logger?.warn('⚠️ [FluxImageTool] Endpoint error, trying next', { 
            endpoint: endpoint.name,
            error: error instanceof Error ? error.message : String(error)
          });
          continue;
        }
      }

      // Все endpoints не сработали
      logger?.error('❌ [FluxImageTool] All endpoints failed', { lastError, user_id });

      return {
        success: false,
        message: "⚠️ Все премиум сервисы временно недоступны. Попробуйте через несколько минут или используйте базовый сервис.",
        daily_count: 0,
        limit_reached: false
      };

    } catch (error) {
      logger?.error('❌ [FluxImageTool] Error during premium image generation', {
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