import { GoogleGenerativeAI } from "@google/generative-ai";
import { resolveImageUrls } from "./telegramFileResolver";

interface HubaiGeminiRequest {
  prompt: string;
  model?: 'gemini-2.0-flash-lite' | 'gemini-2.5-flash-image-preview';
  sourceImages?: string[];
}

interface HubaiGeminiResult {
  success: boolean;
  imageBase64?: string;
  description?: string;
  error?: string;
}

interface LoggerInterface {
  info: (message: string, data?: any) => void;
  error: (message: string, data?: any) => void;
  debug: (message: string, data?: any) => void;
}

/**
 * Правильный Nano Banana генератор изображений используя Google Generative AI SDK
 * с hubai.loe.gg базовым URL
 */
export class HubaiGeminiGenerator {
  private genAI: GoogleGenerativeAI | null = null;
  private logger?: LoggerInterface;
  private apiKey: string;

  constructor(logger?: LoggerInterface) {
    this.logger = logger;
    this.apiKey = process.env.HUBAI_API_KEY || '';
    
    if (!this.apiKey) {
      this.logger?.error('❌ [HubaiGemini] No HUBAI_API_KEY found in environment variables');
      return;
    }

    try {
      this.logger?.info('🔧 [HubaiGemini] Initializing for hubai.loe.gg API');
      
      // NOTE: Google Generative AI SDK не поддерживает кастомные базовые URL напрямую
      // Поэтому мы будем использовать прямые API вызовы к hubai.loe.gg 
      // Создаем клиент только для совместимости, но основной метод - прямые API вызовы
      this.genAI = new GoogleGenerativeAI(this.apiKey);
      
      this.logger?.info('✅ [HubaiGemini] Initialized for hubai.loe.gg direct API calls');
    } catch (error) {
      this.logger?.error('❌ [HubaiGemini] Failed to initialize', {
        error: error instanceof Error ? error.message : String(error)
      });
      this.genAI = null;
    }
  }

  /**
   * Генерация изображения используя Google Generative AI SDK
   */
  async generateImage(request: HubaiGeminiRequest): Promise<HubaiGeminiResult> {
    const { prompt, model = 'gemini-2.5-flash-image-preview', sourceImages = [] } = request;
    
    this.logger?.info('🍌 [HubaiGemini] Starting image generation', {
      prompt: prompt.substring(0, 100) + (prompt.length > 100 ? '...' : ''),
      model,
      sourceImagesCount: sourceImages.length
    });

    // БЕЗОПАСНО: Преобразуем file_id в URL без логирования токенов
    // Создаем адаптер для совместимости типов логгера
    // Используем простое приведение типа для совместимости
    
    const resolvedImageUrls = await resolveImageUrls(sourceImages, this.logger as any);
    const updatedRequest = { ...request, sourceImages: resolvedImageUrls };

    if (!this.genAI) {
      const errorMsg = 'Google Generative AI client not initialized';
      this.logger?.error('❌ [HubaiGemini] Client not initialized');
      return {
        success: false,
        error: errorMsg
      };
    }

    if (!this.apiKey) {
      const errorMsg = 'HUBAI_API_KEY not found in environment variables';
      this.logger?.error('❌ [HubaiGemini] API key missing');
      return {
        success: false,
        error: errorMsg
      };
    }

    try {
      // Сначала пробуем прямой API вызов к hubai.loe.gg (основной метод)
      this.logger?.info('🔧 [HubaiGemini] Using direct hubai.loe.gg API call as primary method');
      const directResult = await this.tryDirectApiCall(updatedRequest);
      
      if (directResult.success) {
        return directResult;
      }

      this.logger?.info('🔧 [HubaiGemini] Direct API call failed, trying Google SDK fallback');

      // Fallback: пробуем использовать Google SDK (хотя он не поддерживает кастомный URL)
      // Получаем модель
      this.logger?.info('🔧 [HubaiGemini] Getting model instance', { model });
      const geminiModel = this.genAI.getGenerativeModel({ model });

      // Подготавливаем контент для генерации
      const parts: any[] = [];

      // Добавляем исходные изображения, если есть
      if (updatedRequest.sourceImages && updatedRequest.sourceImages.length > 0) {
        this.logger?.info('🔧 [HubaiGemini] Processing source images', { 
          count: updatedRequest.sourceImages.length 
        });

        for (const imageUrl of updatedRequest.sourceImages.slice(0, 4)) { // Ограничиваем до 4 изображений
          try {
            const imageData = await this.fetchImageAsBase64(imageUrl);
            if (imageData) {
              parts.push({
                inlineData: {
                  data: imageData.base64,
                  mimeType: imageData.mimeType
                }
              });
              
              this.logger?.debug('✅ [HubaiGemini] Added source image', {
                mimeType: imageData.mimeType,
                size: imageData.base64.length
              });
            }
          } catch (error) {
            this.logger?.error('⚠️ [HubaiGemini] Failed to process source image', {
              imageUrl,
              error: error instanceof Error ? error.message : String(error)
            });
          }
        }
      }

      // Создаем специальный промпт для генерации изображений
      let enhancedPrompt: string;
      
      if (model === 'gemini-2.0-flash-lite') {
        enhancedPrompt = `Generate an image: ${prompt}

Please create a high-quality, detailed image based on this description. The image should be visually appealing and match the provided description as closely as possible.

Style: High resolution, detailed, professional quality
Format: Return the generated image`;
      } else {
        // gemini-2.5-flash-image-preview
        enhancedPrompt = `Create a new image based on: ${prompt}

Generate a high-quality image that matches this description. 
${updatedRequest.sourceImages.length > 0 ? 'Use the provided source images as reference or inspiration for the new image.' : ''}
Make the image detailed, visually appealing, and professionally rendered.

Requirements:
- High quality and detailed
- Match the description provided
- Professional appearance
- Creative and visually appealing`;
      }

      parts.push({ text: enhancedPrompt });

      this.logger?.info('🔧 [HubaiGemini] Calling generateContent with enhanced prompt', {
        model,
        partsCount: parts.length,
        hasSourceImages: updatedRequest.sourceImages.length > 0
      });

      // Вызываем генерацию контента
      const result = await geminiModel.generateContent(parts);
      const response = await result.response;
      
      this.logger?.info('📝 [HubaiGemini] Received response from model', {
        model,
        hasResponse: !!response
      });

      // Пробуем извлечь изображение из ответа
      const imageBase64 = await this.extractImageFromResponse(response);
      
      if (imageBase64) {
        this.logger?.info('✅ [HubaiGemini] Successfully generated image via SDK fallback', {
          model,
          imageSize: imageBase64.length,
          prompt: prompt.substring(0, 50) + '...'
        });

        return {
          success: true,
          imageBase64,
          description: `Image generated using ${model} for: ${prompt.substring(0, 100)}${prompt.length > 100 ? '...' : ''}`
        };
      } else {
        return {
          success: false,
          error: 'No valid image data found in any method'
        };
      }

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger?.error('❌ [HubaiGemini] Error during image generation', {
        error: errorMessage,
        model,
        prompt: prompt.substring(0, 50) + '...'
      });

      return {
        success: false,
        error: `Image generation failed: ${errorMessage}`
      };
    }
  }

  /**
   * Извлечение изображения из ответа модели
   */
  private async extractImageFromResponse(response: any): Promise<string | null> {
    this.logger?.debug('🔍 [HubaiGemini] Extracting image from response');

    try {
      // Проверяем различные возможные структуры ответа
      if (response.candidates && response.candidates[0]) {
        const candidate = response.candidates[0];
        
        // Проверяем content части
        if (candidate.content && candidate.content.parts) {
          for (const part of candidate.content.parts) {
            // Проверяем inline_data
            if (part.inline_data && part.inline_data.data) {
              this.logger?.debug('✅ [HubaiGemini] Found image in inline_data');
              return part.inline_data.data;
            }
            
            // Проверяем text на base64 данные
            if (part.text) {
              const imageBase64 = this.extractBase64FromText(part.text);
              if (imageBase64) {
                this.logger?.debug('✅ [HubaiGemini] Found image in text part');
                return imageBase64;
              }
            }
          }
        }
      }

      // Проверяем raw response text
      const responseText = response.text ? await response.text() : '';
      if (responseText) {
        const imageBase64 = this.extractBase64FromText(responseText);
        if (imageBase64) {
          this.logger?.debug('✅ [HubaiGemini] Found image in response text');
          return imageBase64;
        }
      }

      this.logger?.debug('⚠️ [HubaiGemini] No image found in response');
      return null;

    } catch (error) {
      this.logger?.error('❌ [HubaiGemini] Error extracting image from response', {
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  }

  /**
   * Извлечение base64 данных из текста
   */
  private extractBase64FromText(text: string): string | null {
    // Паттерны для поиска base64 данных
    const base64Patterns = [
      /data:image\/[^;]+;base64,([A-Za-z0-9+/=]+)/g,
      /base64:([A-Za-z0-9+/=]+)/g,
      /([A-Za-z0-9+/=]{100,})/g
    ];

    for (const pattern of base64Patterns) {
      const match = text.match(pattern);
      if (match && match[0]) {
        const imageBase64 = match[0].includes(',') ? match[0].split(',')[1] : match[1] || match[0];
        if (imageBase64 && imageBase64.length > 100) {
          return imageBase64;
        }
      }
    }

    return null;
  }

  /**
   * Прямой API вызов к hubai.loe.gg (основной метод)
   */
  private async tryDirectApiCall(request: HubaiGeminiRequest): Promise<HubaiGeminiResult> {
    const { prompt, model = 'gemini-2.5-flash-image-preview', sourceImages = [] } = request;
    
    // БЕЗОПАСНО: Преобразуем file_id в URL без логирования токенов
    const loggerAdapter = this.logger ? {
      info: this.logger.info.bind(this.logger),
      error: this.logger.error.bind(this.logger),
      debug: this.logger.debug.bind(this.logger),
      warn: this.logger.info.bind(this.logger),
      trackException: () => {},
      getTransports: () => [],
      getLogs: () => [],
      getLogsByRunId: () => []
    } : undefined;
    
    const resolvedImageUrls = await resolveImageUrls(sourceImages, this.logger as any);
    const updatedRequest = { ...request, sourceImages: resolvedImageUrls };
    
    this.logger?.info('🔧 [HubaiGemini] Making direct API call to hubai.loe.gg', { model });

    try {
      // Пробуем разные API endpoints в зависимости от модели
      const endpoints = [
        // Основной endpoint для генерации контента
        {
          url: `https://hubai.loe.gg/v1beta/models/${model}:generateContent`,
          method: 'generateContent'
        },
        // Chat completions endpoint (как в оригинальном nanoBananoGenerator)
        {
          url: 'https://hubai.loe.gg/v1/chat/completions',
          method: 'chatCompletions'
        }
      ];

      for (const endpoint of endpoints) {
        try {
          this.logger?.info('🔧 [HubaiGemini] Trying endpoint', { 
            url: endpoint.url, 
            method: endpoint.method 
          });

          const result = await this.callEndpoint(endpoint, request);
          if (result.success) {
            return result;
          }
        } catch (error) {
          this.logger?.debug('⚠️ [HubaiGemini] Endpoint failed, trying next', { 
            endpoint: endpoint.method,
            error: error instanceof Error ? error.message : String(error)
          });
          continue;
        }
      }

      // Если все endpoints не сработали
      this.logger?.error('❌ [HubaiGemini] All direct API endpoints failed');
      return {
        success: false,
        error: 'All direct API endpoints failed'
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger?.error('❌ [HubaiGemini] Direct API call exception', {
        error: errorMessage
      });

      return {
        success: false,
        error: `Direct API call exception: ${errorMessage}`
      };
    }
  }

  /**
   * Вызов конкретного endpoint
   */
  private async callEndpoint(endpoint: {url: string, method: string}, request: HubaiGeminiRequest): Promise<HubaiGeminiResult> {
    const { prompt, model = 'gemini-2.5-flash-image-preview', sourceImages = [] } = request;
    
    // БЕЗОПАСНО: Преобразуем file_id в URL без логирования токенов
    const loggerAdapter = this.logger ? {
      info: this.logger.info.bind(this.logger),
      error: this.logger.error.bind(this.logger),
      debug: this.logger.debug.bind(this.logger),
      warn: this.logger.info.bind(this.logger),
      trackException: () => {},
      getTransports: () => [],
      getLogs: () => [],
      getLogsByRunId: () => []
    } : undefined;
    
    const resolvedImageUrls = await resolveImageUrls(sourceImages, this.logger as any);
    const updatedRequest = { ...request, sourceImages: resolvedImageUrls };

    if (endpoint.method === 'generateContent') {
      // Используем Google AI API format для generateContent
      const parts: any[] = [];

      // Добавляем исходные изображения
      if (updatedRequest.sourceImages && updatedRequest.sourceImages.length > 0) {
        this.logger?.info('🖼️ [HubaiGemini] Processing multiple source images', { 
          totalImages: updatedRequest.sourceImages.length,
          maxImages: 4
        });
        
        let processedImages = 0;
        for (const imageUrl of updatedRequest.sourceImages.slice(0, 4)) {
          try {
            this.logger?.debug('🔧 [HubaiGemini] Processing image', { 
              imageUrl: imageUrl.substring(0, 50) + '...',
              imageIndex: processedImages + 1
            });
            
            const imageData = await this.fetchImageAsBase64(imageUrl);
            if (imageData) {
              parts.push({
                inlineData: {
                  data: imageData.base64,
                  mimeType: imageData.mimeType
                }
              });
              processedImages++;
              this.logger?.info('✅ [HubaiGemini] Image processed successfully', { 
                imageIndex: processedImages,
                mimeType: imageData.mimeType,
                sizeKB: Math.round(imageData.base64.length / 1024)
              });
            } else {
              this.logger?.error('❌ [HubaiGemini] Failed to convert image to base64', { 
                imageUrl: imageUrl.substring(0, 50) + '...'
              });
            }
          } catch (error) {
            this.logger?.error('❌ [HubaiGemini] Error processing source image', { 
              imageUrl: imageUrl.substring(0, 50) + '...',
              error: error instanceof Error ? error.message : String(error)
            });
          }
        }
        
        this.logger?.info('📊 [HubaiGemini] Image processing complete', {
          requestedImages: updatedRequest.sourceImages.length,
          processedImages: processedImages,
          totalParts: parts.length - 1 // -1 потому что текст еще не добавлен
        });
      }

      // Специализированный промпт для генерации изображений
      const imagePrompt = `Create a high-quality image: ${prompt}

Generate a detailed, professional-quality image that accurately represents the description. 
${updatedRequest.sourceImages.length > 0 ? 'Use the provided reference images for inspiration and context.' : ''}

Requirements:
- High resolution and detailed
- Visually appealing and professional
- Accurate representation of the description
- Creative and artistic quality

Please generate the image now.`;

      parts.push({ text: imagePrompt });

      const response = await fetch(endpoint.url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [{
            parts: parts
          }],
          generationConfig: {
            temperature: 0.8,
            topK: 40,
            topP: 0.95,
            maxOutputTokens: 4096,
          },
          safetySettings: [
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" }
          ]
        }),
      });

      if (response.ok) {
        const result = await response.json();
        this.logger?.info('📥 [HubaiGemini] API response received', {
          hasResult: !!result,
          hasCandidates: !!(result.candidates && result.candidates.length > 0),
          candidatesCount: result.candidates ? result.candidates.length : 0,
          responseSize: JSON.stringify(result).length
        });
        
        // ДЕТАЛЬНОЕ ЛОГИРОВАНИЕ: показываем структуру ответа
        this.logger?.info('🔍 [HubaiGemini] DETAILED API RESPONSE STRUCTURE', {
          resultKeys: Object.keys(result || {}),
          fullResult: JSON.stringify(result, null, 2).substring(0, 2000)
        });
        
        if (result.candidates && result.candidates[0]) {
          const candidate = result.candidates[0];
          this.logger?.info('🔍 [HubaiGemini] DETAILED CANDIDATE STRUCTURE', {
            candidateKeys: Object.keys(candidate || {}),
            hasContent: !!candidate.content,
            contentKeys: candidate.content ? Object.keys(candidate.content) : [],
            hasParts: candidate.content && candidate.content.parts,
            partsCount: candidate.content && candidate.content.parts ? candidate.content.parts.length : 0
          });
          
          if (candidate.content && candidate.content.parts) {
            candidate.content.parts.forEach((part: any, index: number) => {
              this.logger?.info(`🔍 [HubaiGemini] PART ${index} STRUCTURE`, {
                partKeys: Object.keys(part || {}),
                hasInlineData: !!part.inlineData,
                hasText: !!part.text,
                textLength: part.text ? part.text.length : 0,
                textPreview: part.text ? part.text.substring(0, 200) + '...' : null
              });
            });
          }
        }
        
        return this.processGenerateContentResponse(result, model, prompt);
      } else {
        const errorText = await response.text();
        this.logger?.error('❌ [HubaiGemini] API request failed', {
          status: response.status,
          statusText: response.statusText,
          errorText: errorText.substring(0, 500) + (errorText.length > 500 ? '...' : '')
        });
        throw new Error(`GenerateContent API failed: ${response.status} - ${errorText}`);
      }

    } else if (endpoint.method === 'chatCompletions') {
      // Используем OpenAI-style API format для chat completions
      const content: any[] = [];

      // Добавляем исходные изображения
      if (updatedRequest.sourceImages && updatedRequest.sourceImages.length > 0) {
        for (const imageUrl of updatedRequest.sourceImages.slice(0, 4)) {
          try {
            const imageData = await this.fetchImageAsBase64(imageUrl);
            if (imageData) {
              content.push({
                type: "image_url",
                image_url: {
                  url: `data:${imageData.mimeType};base64,${imageData.base64}`
                }
              });
            }
          } catch (error) {
            this.logger?.debug('⚠️ [HubaiGemini] Failed to process source image', { imageUrl });
          }
        }
      }

      // Промпт для chat completions
      const chatPrompt = `GENERATE_IMAGE_NOW: ${prompt}

You are an advanced AI image generator. Create a high-quality, detailed image based on the given description. 
${updatedRequest.sourceImages.length > 0 ? 'Use any provided reference images as inspiration or context.' : ''}

CRITICAL: You must actually generate and return a real image, not a text description. 
Return the image as base64-encoded data.

Style: Professional, detailed, high-resolution, visually appealing
Format: Return only the base64 image data

Generate the image now: ${prompt}`;

      content.push({
        type: "text",
        text: chatPrompt
      });

      const response = await fetch(endpoint.url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: content }],
          max_tokens: 4096,
          temperature: 0.8,
        }),
      });

      if (response.ok) {
        const result = await response.json();
        return this.processChatCompletionsResponse(result, model, prompt);
      } else {
        const errorText = await response.text();
        throw new Error(`Chat completions API failed: ${response.status} - ${errorText}`);
      }
    }

    throw new Error(`Unknown endpoint method: ${endpoint.method}`);
  }

  /**
   * Обработка ответа от generateContent API
   */
  private processGenerateContentResponse(result: any, model: string, prompt: string): HubaiGeminiResult {
    this.logger?.info('📝 [HubaiGemini] Processing generateContent response', {
      hasCandidates: !!(result.candidates && result.candidates.length > 0),
      candidatesCount: result.candidates ? result.candidates.length : 0,
      model,
      promptLength: prompt.length
    });

    try {
      if (result.candidates && result.candidates[0]) {
        const candidate = result.candidates[0];
        this.logger?.debug('🔍 [HubaiGemini] Examining first candidate', {
          hasContent: !!candidate.content,
          hasParts: !!(candidate.content && candidate.content.parts),
          partsCount: candidate.content && candidate.content.parts ? candidate.content.parts.length : 0
        });
        
        // Проверяем части контента
        if (candidate.content && candidate.content.parts) {
          for (const part of candidate.content.parts) {
            // Проверяем inline data (изображения)
            if (part.inlineData && part.inlineData.data) {
              this.logger?.info('✅ [HubaiGemini] Found image in generateContent response');
              return {
                success: true,
                imageBase64: part.inlineData.data,
                description: `Image generated using generateContent API with ${model} for: ${prompt.substring(0, 100)}${prompt.length > 100 ? '...' : ''}`
              };
            }
            
            // Проверяем текст на base64 данные
            if (part.text) {
              const imageBase64 = this.extractBase64FromText(part.text);
              if (imageBase64) {
                this.logger?.info('✅ [HubaiGemini] Found image in text part of generateContent response');
                return {
                  success: true,
                  imageBase64,
                  description: `Image extracted from text using generateContent API with ${model}`
                };
              }
            }
          }
        }
      }

      return {
        success: false,
        error: 'No valid image data found in generateContent response'
      };

    } catch (error) {
      return {
        success: false,
        error: `Error processing generateContent response: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  /**
   * Обработка ответа от chat completions API
   */
  private processChatCompletionsResponse(result: any, model: string, prompt: string): HubaiGeminiResult {
    this.logger?.debug('📝 [HubaiGemini] Processing chat completions response');

    try {
      const responseText = result.choices?.[0]?.message?.content || '';
      
      this.logger?.debug('📝 [HubaiGemini] Chat completions response length', {
        responseLength: responseText.length
      });

      // Извлекаем base64 из ответа
      const imageBase64 = this.extractBase64FromText(responseText);
      
      if (imageBase64) {
        this.logger?.info('✅ [HubaiGemini] Found image in chat completions response');
        return {
          success: true,
          imageBase64,
          description: `Image generated using chat completions API with ${model} for: ${prompt.substring(0, 100)}${prompt.length > 100 ? '...' : ''}`
        };
      } else {
        return {
          success: false,
          error: 'No valid image data found in chat completions response'
        };
      }

    } catch (error) {
      return {
        success: false,
        error: `Error processing chat completions response: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  /**
   * Получение изображения как base64 данные
   */
  private async fetchImageAsBase64(imageUrl: string): Promise<{ base64: string; mimeType: string } | null> {
    try {
      this.logger?.debug('🔧 [HubaiGemini] Fetching image', { imageUrl });
      
      const response = await fetch(imageUrl);
      if (!response.ok) {
        this.logger?.error('❌ [HubaiGemini] Failed to fetch image', {
          imageUrl,
          status: response.status
        });
        return null;
      }

      const imageBuffer = await response.arrayBuffer();
      const base64 = Buffer.from(imageBuffer).toString('base64');
      const mimeType = response.headers.get('content-type') || 'image/jpeg';

      this.logger?.debug('✅ [HubaiGemini] Image fetched successfully', {
        mimeType,
        size: base64.length
      });

      return { base64, mimeType };

    } catch (error) {
      this.logger?.error('❌ [HubaiGemini] Error fetching image', {
        imageUrl,
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  }
}

/**
 * Удобная функция для быстрого использования
 */
export async function generateImageWithHubaiGemini(
  request: HubaiGeminiRequest,
  logger?: LoggerInterface
): Promise<HubaiGeminiResult> {
  const generator = new HubaiGeminiGenerator(logger);
  return await generator.generateImage(request);
}

/**
 * Консольный логгер по умолчанию
 */
export const defaultLogger: LoggerInterface = {
  info: (message: string, data?: any) => {
    console.log(message, data ? JSON.stringify(data, null, 2) : '');
  },
  error: (message: string, data?: any) => {
    console.error(message, data ? JSON.stringify(data, null, 2) : '');
  },
  debug: (message: string, data?: any) => {
    console.debug(message, data ? JSON.stringify(data, null, 2) : '');
  }
};