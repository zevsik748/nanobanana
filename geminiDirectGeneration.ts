import { 
  upsertUser, 
  hasReachedDailyLimit, 
  saveImageGeneration,
  isAdminUser 
} from "../../../server/storage";

interface GenerationRequest {
  prompt: string;
  userId: string;
  chatId: string;
  username?: string;
  sourceImages?: string[];
}

interface GenerationResult {
  success: boolean;
  imageBase64?: string;
  message: string;
  dailyCount?: number;
  limitReached: boolean;
}

export async function generateImageDirect(request: GenerationRequest): Promise<GenerationResult> {
  const { prompt, userId, chatId, username, sourceImages } = request;
  
  console.log('🔧 [DirectGeneration] Starting Gemini 2.5 Flash Image Preview generation', { 
    prompt: prompt.substring(0, 50) + "...", 
    userId,
    sourceImagesCount: sourceImages?.length || 0,
    generationType: sourceImages?.length ? 'image-to-image' : 'text-to-image'
  });

  try {
    if (!process.env.HUBAI_API_KEY) {
      console.error('❌ [DirectGeneration] No HUBAI_API_KEY found in environment');
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
      console.log('👑 [DirectGeneration] Admin user detected - unlimited access', { userId });
    }

    // Подготавливаем контент для API запроса
    const content: any[] = [];
    
    // Добавляем исходные изображения если есть (для image-to-image)
    if (sourceImages && sourceImages.length > 0) {
      console.log('📝 [DirectGeneration] Processing source images for image-to-image generation');
      
      const limitedImages = sourceImages.slice(0, 4); // Максимум 4 изображения
      
      for (const imageUrl of limitedImages) {
        try {
          console.log('📝 [DirectGeneration] Downloading source image', { url: imageUrl });
          
          const response = await fetch(imageUrl);
          if (!response.ok) {
            console.warn('⚠️ [DirectGeneration] Failed to download source image', { 
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
          
          console.log('✅ [DirectGeneration] Successfully processed source image', { 
            url: imageUrl,
            mimeType,
            size: imageBuffer.byteLength 
          });
          
        } catch (error) {
          console.error('❌ [DirectGeneration] Error processing source image', { 
            url: imageUrl, 
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
    }

    // Специальный промпт для Nano Banana (Gemini 2.5 Flash Image) генерации
    const isImageToImage = sourceImages && sourceImages.length > 0;
    
    let nanoBananaPrompt: string;
    if (isImageToImage) {
      nanoBananaPrompt = `Create a new image inspired by the uploaded image(s). ${prompt}. 
Style: High quality, detailed, creative interpretation.
Output: Return the generated image.`;
    } else {
      nanoBananaPrompt = `Generate an image: ${prompt}. 
Style: High quality, detailed, photorealistic.
Output: Return the generated image.`;
    }

    // Добавляем промпт для Nano Banana
    content.push({
      type: "text", 
      text: nanoBananaPrompt
    });

    console.log('📝 [DirectGeneration] Making API request to hubai.loe.gg with images endpoint');

    // Попробуем специальный эндпоинт для генерации изображений
    const apiResponse = await fetch('https://hubai.loe.gg/v1/images/generations', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.HUBAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'imagen-3.0-generate-001', // Попробуем рабочую модель Imagen
        prompt: nanoBananaPrompt,
        n: 1,
        size: '1024x1024',
        response_format: 'b64_json'
      }),
    });

    if (!apiResponse.ok) {
      const errorText = await apiResponse.text();
      console.error('❌ [DirectGeneration] API error', { 
        status: apiResponse.status, 
        error: errorText 
      });
      return {
        success: false,
        message: "❌ Ошибка API генерации. Попробуйте позже.",
        limitReached: false
      };
    }

    const apiResult = await apiResponse.json();
    const responseText = apiResult.choices?.[0]?.message?.content || '';

    // Улучшенная обработка ответа от Nano Banana (Gemini 2.5 Flash Image)
    let imageBase64 = "";
    let imageDescription = "";
    
    console.log('🔧 [DirectGeneration] Processing Nano Banana response', { 
      responseLength: responseText.length,
      responseSample: responseText.substring(0, 300),
      fullApiResult: JSON.stringify(apiResult, null, 2)
    });
    
    // Проверяем разные форматы ответа от Nano Banana
    if (apiResult.choices?.[0]?.message?.content) {
      const content = apiResult.choices[0].message.content;
      
      // 1. Проверяем, есть ли изображение в content (может быть в других полях)
      if (typeof content === 'object' && content.image) {
        imageBase64 = content.image;
      }
      // 2. Ищем base64 в тексте ответа
      else if (typeof content === 'string') {
        const base64Patterns = [
          /data:image\/[^;]+;base64,([A-Za-z0-9+/=]+)/g,
          /base64[:\s]*([A-Za-z0-9+/=]{100,})/gi,
          /image[:\s]*([A-Za-z0-9+/=]{100,})/gi,
          /([A-Za-z0-9+/=]{500,})/g  // Длинная строка base64 (минимум 500 символов)
        ];
        
        for (const pattern of base64Patterns) {
          const match = content.match(pattern);
          if (match && match[1]) {
            imageBase64 = match[1];
            break;
          } else if (match && match[0] && match[0].length > 500) {
            imageBase64 = match[0].includes(',') ? match[0].split(',')[1] : match[0];
            break;
          }
        }
      }
    }
    
    // 3. Проверяем другие поля ответа где может быть изображение
    if (!imageBase64) {
      if (apiResult.image) {
        imageBase64 = apiResult.image;
      } else if (apiResult.data?.image) {
        imageBase64 = apiResult.data.image;
      } else if (apiResult.choices?.[0]?.image) {
        imageBase64 = apiResult.choices[0].image;
      }
    }

    // Валидация base64 изображения
    if (imageBase64 && imageBase64.length > 100) {
      // Проверяем, что это действительно base64 изображения
      const isValidBase64 = /^[A-Za-z0-9+/=]+$/.test(imageBase64.replace(/\s/g, ''));
      
      if (isValidBase64) {
        imageDescription = isImageToImage ? 
          `Nano Banana создал изображение на основе вашего фото: ${prompt}` : 
          `Nano Banana сгенерировал: ${prompt}`;
          
        console.log('✅ [DirectGeneration] Valid base64 image found', { 
          imageDataLength: imageBase64.length,
          description: imageDescription
        });
      } else {
        imageBase64 = "";
      }
    }

    if (!imageBase64) {
      console.error('❌ [DirectGeneration] No valid image data from Nano Banana', { 
        responseLength: responseText.length,
        responseSample: responseText.substring(0, 400),
        apiResultKeys: Object.keys(apiResult),
        choicesLength: apiResult.choices?.length || 0
      });
      
      return {
        success: false,
        message: isImageToImage ? 
          "❌ Nano Banana не смог создать изображение на основе загруженного фото. Попробуйте другое изображение или описание." :
          "❌ Nano Banana не смог сгенерировать изображение. Попробуйте другое описание!",
        limitReached: false
      };
    }

    console.log('✅ [DirectGeneration] Image generated successfully', { 
      imageDataLength: imageBase64.length,
      description: imageDescription
    });

    // Создаем URL для сохранения в базу
    const imageUrl = `hubai://gemini-2.5-flash-image-preview/${Date.now()}-${userId}`;

    // Сохраняем запись генерации в базу данных
    await saveImageGeneration(userId, prompt, imageUrl);

    // ПРИМЕЧАНИЕ: Счетчик пользователя теперь увеличивается в workflow step2 ТОЛЬКО после успешной отправки изображения

    const successMessage = isImageToImage ? 
      `✅ Новое изображение создано на основе вашего фото! ${imageDescription}` :
      `✅ Готово! ${imageDescription || 'Изображение сгенерировано.'}`;

    return {
      success: true,
      imageBase64: imageBase64,
      message: successMessage,
      dailyCount: 0, // Счетчик теперь управляется в workflow step2
      limitReached: false
    };

  } catch (error) {
    console.error('❌ [DirectGeneration] Error during image generation', {
      error: error instanceof Error ? error.message : String(error),
      userId,
      prompt: prompt.substring(0, 50) + "..."
    });

    // Обработка специфических ошибок
    if (error instanceof Error) {
      const errorMessage = error.message.toLowerCase();
      
      if (errorMessage.includes('rate limit') || errorMessage.includes('quota')) {
        return {
          success: false,
          message: "⏱️ API временно перегружен. Попробуйте через несколько секунд.",
          limitReached: false
        };
      }
      
      if (errorMessage.includes('content policy') || errorMessage.includes('safety')) {
        return {
          success: false,
          message: "🛡️ Ваш запрос нарушает правила безопасности. Попробуйте изменить описание.",
          limitReached: false
        };
      }
      
      if (errorMessage.includes('invalid') || errorMessage.includes('unauthorized')) {
        return {
          success: false,
          message: "❌ Ошибка авторизации API. Обратитесь к администратору.",
          limitReached: false
        };
      }
    }

    return {
      success: false,
      message: "❌ Ошибка при генерации, обратитесь к @dmitriy_ferixdi",
      limitReached: false
    };
  }
}