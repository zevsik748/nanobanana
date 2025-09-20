import { createTool } from "@mastra/core/tools";
import type { IMastraLogger } from "@mastra/core/logger";
import { z } from "zod";
import { 
  upsertUser, 
  hasReachedDailyLimit, 
  saveImageGeneration 
} from "../../../server/storage";

export const stableDiffusionXLTool = createTool({
  id: "stable-diffusion-xl-tool",
  description: "Generate ultra high-quality images using Stable Diffusion XL through free endpoints. Professional quality comparable to premium services, UNLIMITED usage!",
  inputSchema: z.object({
    prompt: z.string().describe("Description of the image to generate (in any language)"),
    user_id: z.string().describe("Telegram user ID for tracking limits and history"),
    chat_id: z.string().describe("Telegram chat ID for context"),
    username: z.string().optional().describe("Username of the user requesting the image"),
    negative_prompt: z.string().default("blurry, low quality, distorted").describe("What to avoid in the image"),
  }),
  outputSchema: z.object({
    success: z.boolean().describe("Whether the image generation was successful"),
    image_base64: z.string().optional().describe("Base64 encoded image data for Telegram"),
    message: z.string().describe("Status message for the user"),
    daily_count: z.number().describe("User's current daily image count"),
    limit_reached: z.boolean().describe("Whether user has reached daily limit"),
  }),
  execute: async ({ context: { prompt, user_id, chat_id, username, negative_prompt }, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info('🔧 [StableDiffusionXLTool] Starting ultra high-quality image generation', { 
      prompt: prompt.substring(0, 50) + "...", 
      user_id,
      chat_id,
      username
    });

    try {
      logger?.info('📝 [StableDiffusionXLTool] Upserting user in database');
      await upsertUser(user_id, username || `user_${user_id}`);

      logger?.info('📝 [StableDiffusionXLTool] Starting unlimited SDXL generation (no limits!)');
      // Безлимитная генерация - проверки лимитов убраны!

      // Улучшенный промпт для качества
      const enhancedPrompt = `masterpiece, best quality, ultra detailed, 8k, photorealistic, ${prompt}`;

      // Список бесплатных SDXL endpoints
      const endpoints = [
        {
          name: "Pollinations SDXL",
          url: `https://image.pollinations.ai/prompt/${encodeURIComponent(enhancedPrompt)}?width=1024&height=1024&model=sdxl&negative=${encodeURIComponent(negative_prompt)}&seed=${Math.floor(Math.random() * 1000000)}&nologo=true`,
          method: 'GET'
        },
        {
          name: "Segmind SDXL",
          url: 'https://api.segmind.com/v1/sdxl1.0-txt2img',
          method: 'POST',
          body: {
            prompt: enhancedPrompt,
            negative_prompt: negative_prompt,
            style: "photographic",
            samples: 1,
            scheduler: "DPM++ 2M Karras",
            num_inference_steps: 30,
            guidance_scale: 7.5,
            strength: 1,
            seed: Math.floor(Math.random() * 1000000),
            img_width: 1024,
            img_height: 1024,
            refiner: true
          }
        },
        {
          name: "ProxyAPI SDXL",
          url: 'https://api.proxyapi.ru/openai/v1/images/generations',
          method: 'POST',
          body: {
            model: "sdxl",
            prompt: enhancedPrompt,
            n: 1,
            size: "1024x1024",
            quality: "hd",
            style: "vivid"
          }
        }
      ];

      let lastError = null;

      // Пробуем каждый endpoint
      for (const endpoint of endpoints) {
        try {
          logger?.info('📝 [StableDiffusionXLTool] Trying SDXL endpoint', { 
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

              if (imageBase64 && imageBlob.byteLength > 2000) { // Увеличенный размер для SDXL
                logger?.info('✅ [StableDiffusionXLTool] Ultra high-quality SDXL image generated', { 
                  endpoint: endpoint.name,
                  imageDataLength: imageBase64.length 
                });

                // Создаем URL для сохранения в базу
                const imageUrl = `sdxl://${endpoint.name}/${Date.now()}-${user_id}`;

                // Сохраняем запись генерации в базу данных
                logger?.info('📝 [StableDiffusionXLTool] Saving generation record to database');
                await saveImageGeneration(user_id, prompt, imageUrl);

                // ПРИМЕЧАНИЕ: Счетчик пользователя теперь увеличивается в workflow step2 ТОЛЬКО после успешной отправки изображения

                logger?.info('✅ [StableDiffusionXLTool] Ultra high-quality generation completed', {
                  user_id,
                  prompt: prompt.substring(0, 50) + "...",
                  imageSize: imageBase64.length,
                  endpoint: endpoint.name
                });

                return {
                  success: true,
                  image_base64: imageBase64,
                  message: `🏆 Изображение сгенерировано в ультра качестве SDXL! Сервис: ${endpoint.name}`,
                  daily_count: 0, // Счетчик теперь управляется в workflow step2
                  limit_reached: false
                };
              }
            } else {
              // JSON ответ с данными
              const result = await response.json();
              
              // Разные форматы ответов
              let imageData = null;
              if (result.data && result.data[0] && result.data[0].url) {
                imageData = result.data[0].url;
              } else if (result.output) {
                imageData = result.output;
              } else if (result.image) {
                imageData = result.image;
              } else if (result.url) {
                imageData = result.url;
              }
              
              if (imageData) {
                let imageBase64;
                
                if (imageData.startsWith('data:image/')) {
                  // Base64 data URL
                  imageBase64 = imageData.split(',')[1];
                } else if (imageData.startsWith('http')) {
                  // URL для скачивания
                  const imageResponse = await fetch(imageData);
                  if (imageResponse.ok) {
                    const imageBlob = await imageResponse.arrayBuffer();
                    imageBase64 = Buffer.from(imageBlob).toString('base64');
                  }
                } else {
                  // Уже base64
                  imageBase64 = imageData;
                }
                
                if (imageBase64 && imageBase64.length > 1000) {
                  logger?.info('✅ [StableDiffusionXLTool] SDXL image processed successfully', { 
                    endpoint: endpoint.name,
                    imageDataLength: imageBase64.length 
                  });

                  const dbImageUrl = `sdxl://${endpoint.name}/${Date.now()}-${user_id}`;
                  await saveImageGeneration(user_id, prompt, dbImageUrl);
                  // ПРИМЕЧАНИЕ: Счетчик пользователя теперь увеличивается в workflow step2 ТОЛЬКО после успешной отправки изображения

                  return {
                    success: true,
                    image_base64: imageBase64,
                    message: `🏆 Изображение сгенерировано в ультра качестве SDXL! Сервис: ${endpoint.name}`,
                    daily_count: 0, // Счетчик теперь управляется в workflow step2
                    limit_reached: false
                  };
                }
              }
            }
          }
          
          lastError = `${endpoint.name}: ${response.status} ${response.statusText}`;
          logger?.warn('⚠️ [StableDiffusionXLTool] SDXL endpoint failed, trying next', { 
            endpoint: endpoint.name,
            status: response.status 
          });

        } catch (error) {
          lastError = `${endpoint.name}: ${error instanceof Error ? error.message : String(error)}`;
          logger?.warn('⚠️ [StableDiffusionXLTool] SDXL endpoint error, trying next', { 
            endpoint: endpoint.name,
            error: error instanceof Error ? error.message : String(error)
          });
          continue;
        }
      }

      // Все endpoints не сработали
      logger?.error('❌ [StableDiffusionXLTool] All SDXL endpoints failed', { lastError, user_id });

      return {
        success: false,
        message: "⚠️ Все ультра качественные сервисы временно недоступны. Попробуйте базовый сервис или повторите позже.",
        daily_count: 0,
        limit_reached: false
      };

    } catch (error) {
      logger?.error('❌ [StableDiffusionXLTool] Error during SDXL generation', {
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