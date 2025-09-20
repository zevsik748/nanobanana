import { 
  upsertUser, 
  hasReachedDailyLimit, 
  incrementUserImageCount, 
  saveImageGeneration,
  isAdminUser 
} from "../../../server/storage";

interface NanoBananoRequest {
  prompt: string;
  userId: string;
  chatId: string;
  username?: string;
  sourceImages?: string[];
}

interface NanoBananoResult {
  success: boolean;
  imageBase64?: string;
  message: string;
  dailyCount?: number;
  limitReached: boolean;
}

/**
 * Nano Banano Image Generator - попробует разные методы генерации
 */
export async function generateNanoBananoImage(request: NanoBananoRequest): Promise<NanoBananoResult> {
  const { prompt, userId, chatId, username, sourceImages } = request;
  
  console.log('🍌 [NanoBanano] Starting Nano Banano image generation', { 
    prompt: prompt.substring(0, 50) + "...", 
    userId,
    sourceImagesCount: sourceImages?.length || 0,
  });

  try {
    if (!process.env.HUBAI_API_KEY) {
      console.error('❌ [NanoBanano] No HUBAI_API_KEY found in environment');
      return {
        success: false,
        message: "❌ Сервис генерации изображений временно недоступен. API ключ не настроен.",
        limitReached: false
      };
    }
    
    // Обеспечиваем существование пользователя в базе данных
    await upsertUser(userId, username || `user_${userId}`);

    // Проверяем лимиты (админы имеют безлимитный доступ)
    const isAdmin = isAdminUser(userId);
    const limitReached = await hasReachedDailyLimit(userId);
    
    if (limitReached && !isAdmin) {
      return {
        success: false,
        message: "🚫 Превышен дневной лимит генерации. Попробуйте завтра!",
        dailyCount: 15,
        limitReached: true
      };
    }
    
    if (isAdmin) {
      console.log('👑 [NanoBanano] Admin user detected - unlimited access', { userId });
    }

    // Методы генерации по приоритету
    const generationMethods = [
      () => tryOpenAIImagesAPI(prompt, sourceImages),
      () => tryGeminiWithImagePrompt(prompt, sourceImages),
      () => tryHuggingFaceAPI(prompt),
      () => tryDeepAIGeneration(prompt),
    ];

    let lastError = "";
    
    for (const method of generationMethods) {
      try {
        console.log('🔧 [NanoBanano] Trying generation method...');
        const result = await method();
        
        if (result.success && result.imageBase64) {
          console.log('✅ [NanoBanano] Generation successful!', { 
            imageDataLength: result.imageBase64.length 
          });

          // Сохраняем запись генерации в базу данных
          const imageUrl = `nano-banano://generated/${Date.now()}-${userId}`;
          await saveImageGeneration(userId, prompt, imageUrl);

          // Увеличиваем дневной счетчик пользователя
          const updatedUser = await incrementUserImageCount(userId);

          const isImageToImage = sourceImages && sourceImages.length > 0;
          const successMessage = isImageToImage ? 
            `✅ Nano Banano создал новое изображение на основе вашего фото!` :
            `✅ Nano Banano сгенерировал изображение: ${prompt}`;

          return {
            success: true,
            imageBase64: result.imageBase64,
            message: successMessage,
            dailyCount: updatedUser.daily_image_count,
            limitReached: false
          };
        }
        
        lastError = result.message || "Неизвестная ошибка";
        
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        console.log('⚠️ [NanoBanano] Method failed, trying next...', { error: lastError });
        continue;
      }
    }

    // Все методы не сработали
    console.error('❌ [NanoBanano] All generation methods failed', { lastError });
    
    return {
      success: false,
      message: `❌ Nano Banano не смог сгенерировать изображение. Попробуйте другое описание!`,
      limitReached: false
    };

  } catch (error) {
    console.error('❌ [NanoBanano] Critical error', {
      error: error instanceof Error ? error.message : String(error),
      userId,
      prompt: prompt.substring(0, 50) + "..."
    });

    return {
      success: false,
      message: "❌ Произошла критическая ошибка. Попробуйте еще раз!",
      limitReached: false
    };
  }
}

/**
 * Метод 1: Попытка через OpenAI Images API эндпоинт
 */
async function tryOpenAIImagesAPI(prompt: string, sourceImages?: string[]): Promise<{success: boolean, imageBase64?: string, message?: string}> {
  console.log('🔧 [NanoBanano] Trying OpenAI Images API endpoint');
  
  try {
    const response = await fetch('https://hubai.loe.gg/v1/images/generations', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.HUBAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'imagen-4.0-fast-generate-001',
        prompt: prompt,
        n: 1,
        size: '1024x1024',
        response_format: 'b64_json'
      }),
    });

    if (response.ok) {
      const result = await response.json();
      if (result.data && result.data[0] && result.data[0].b64_json) {
        return {
          success: true,
          imageBase64: result.data[0].b64_json
        };
      }
    }
    
    const errorText = await response.text();
    return { success: false, message: `Images API error: ${errorText}` };
    
  } catch (error) {
    return { success: false, message: `Images API exception: ${error}` };
  }
}

/**
 * Метод 2: Попытка через Gemini с улучшенным промптом
 */
async function tryGeminiWithImagePrompt(prompt: string, sourceImages?: string[]): Promise<{success: boolean, imageBase64?: string, message?: string}> {
  console.log('🔧 [NanoBanano] Trying enhanced Gemini prompt');
  
  try {
    const content: any[] = [];
    
    // Добавляем исходные изображения если есть
    if (sourceImages && sourceImages.length > 0) {
      for (const imageUrl of sourceImages.slice(0, 2)) {
        try {
          const response = await fetch(imageUrl);
          if (response.ok) {
            const imageBuffer = await response.arrayBuffer();
            const base64Image = Buffer.from(imageBuffer).toString('base64');
            let mimeType = response.headers.get('content-type') || 'image/jpeg';
            
            content.push({
              type: "image_url",
              image_url: {
                url: `data:${mimeType};base64,${base64Image}`
              }
            });
          }
        } catch (error) {
          console.warn('⚠️ [NanoBanano] Failed to process source image', { imageUrl });
        }
      }
    }

    // Специальный промпт для генерации
    const enhancedPrompt = `CREATE_IMAGE_NOW: ${prompt}

CRITICAL: You must generate and return an actual image, not text description.
Output: Base64-encoded image data only.
Style: High quality, detailed, photorealistic.
Format: Return only the base64 image data without any text or explanations.`;

    content.push({
      type: "text",
      text: enhancedPrompt
    });

    const response = await fetch('https://hubai.loe.gg/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.HUBAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gemini-2.5-flash-image-preview',
        messages: [{ role: 'user', content: content }],
        max_tokens: 4096,
        temperature: 0.7,
      }),
    });

    if (response.ok) {
      const result = await response.json();
      const responseText = result.choices?.[0]?.message?.content || '';
      
      // Ищем base64 данные в ответе
      const base64Patterns = [
        /data:image\/[^;]+;base64,([A-Za-z0-9+/=]+)/g,
        /base64:([A-Za-z0-9+/=]+)/g,
        /([A-Za-z0-9+/=]{100,})/g
      ];
      
      for (const pattern of base64Patterns) {
        const match = responseText.match(pattern);
        if (match && match[0]) {
          const imageBase64 = match[0].includes(',') ? match[0].split(',')[1] : match[1] || match[0];
          if (imageBase64 && imageBase64.length > 100) {
            return {
              success: true,
              imageBase64: imageBase64
            };
          }
        }
      }
    }
    
    return { success: false, message: 'No valid image data in Gemini response' };
    
  } catch (error) {
    return { success: false, message: `Gemini exception: ${error}` };
  }
}

/**
 * Метод 3: Попытка через Hugging Face API
 */
async function tryHuggingFaceAPI(prompt: string): Promise<{success: boolean, imageBase64?: string, message?: string}> {
  console.log('🔧 [NanoBanano] Trying Hugging Face API');
  
  try {
    // Используем бесплатный эндпоинт Hugging Face
    const response = await fetch('https://api-inference.huggingface.co/models/stabilityai/stable-diffusion-2-1', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        inputs: prompt,
        options: { wait_for_model: true }
      }),
    });

    if (response.ok) {
      const imageBuffer = await response.arrayBuffer();
      if (imageBuffer.byteLength > 1000) { // Минимальный размер изображения
        const base64Image = Buffer.from(imageBuffer).toString('base64');
        return {
          success: true,
          imageBase64: base64Image
        };
      }
    }
    
    return { success: false, message: 'HuggingFace API failed' };
    
  } catch (error) {
    return { success: false, message: `HuggingFace exception: ${error}` };
  }
}

/**
 * Метод 4: Попытка через DeepAI API
 */
async function tryDeepAIGeneration(prompt: string): Promise<{success: boolean, imageBase64?: string, message?: string}> {
  console.log('🔧 [NanoBanano] Trying DeepAI API');
  
  try {
    const formData = new FormData();
    formData.append('text', prompt);
    
    const response = await fetch('https://api.deepai.org/api/text2img', {
      method: 'POST',
      body: formData,
    });

    if (response.ok) {
      const result = await response.json();
      if (result.output_url) {
        // Скачиваем изображение и конвертируем в base64
        const imageResponse = await fetch(result.output_url);
        if (imageResponse.ok) {
          const imageBuffer = await imageResponse.arrayBuffer();
          const base64Image = Buffer.from(imageBuffer).toString('base64');
          return {
            success: true,
            imageBase64: base64Image
          };
        }
      }
    }
    
    return { success: false, message: 'DeepAI API failed' };
    
  } catch (error) {
    return { success: false, message: `DeepAI exception: ${error}` };
  }
}