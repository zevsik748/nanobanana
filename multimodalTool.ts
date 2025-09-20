import { createTool } from "@mastra/core/tools";
import type { IMastraLogger } from "@mastra/core/logger";
import { z } from "zod";
import { generateObject } from "ai";

export const multimodalTool = createTool({
  id: "multimodal-processor",
  description: "Process text messages and images (1-4 photos) using Google Gemini 2.5 Flash Image Preview AI via hubai.loe.gg. Can analyze images, answer questions about them, and handle mixed text+image content.",
  inputSchema: z.object({
    message: z.string().describe("The text message from the user"),
    imageUrls: z.array(z.string()).optional().describe("Array of image URLs to process (max 4 images)"),
    chatId: z.string().describe("Telegram chat ID for context"),
    userName: z.string().optional().describe("Username of the person sending the message"),
  }),
  outputSchema: z.object({
    response: z.string().describe("The AI-generated response to the user"),
    processedImages: z.number().describe("Number of images that were processed"),
  }),
  execute: async ({ context: { message, imageUrls, chatId, userName }, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info('🔧 [MultimodalTool] Starting execution', { 
      message: message.substring(0, 100), 
      imageCount: imageUrls?.length || 0,
      chatId,
      userName 
    });

    try {
      // Import OpenAI SDK для hubai.loe.gg
      const { createOpenAI } = await import("@ai-sdk/openai");
      const { generateText } = await import("ai");
      
      if (!process.env.HUBAI_API_KEY) {
        throw new Error("HUBAI_API_KEY not found in environment variables");
      }

      logger?.info('📝 [MultimodalTool] Using hubai.loe.gg API key:', { keyPrefix: process.env.HUBAI_API_KEY.substring(0, 10) + '...' });

      // Initialize OpenAI client for hubai.loe.gg
      const openai = createOpenAI({
        apiKey: process.env.HUBAI_API_KEY,
        baseURL: 'https://hubai.loe.gg/v1',
      });

      logger?.info('📝 [MultimodalTool] Initialized Gemini 2.5 Flash Image Preview via hubai.loe.gg');

      // Prepare content for OpenAI format
      const content: any[] = [];
      
      // Add text message
      if (message && message.trim()) {
        content.push({ type: "text", text: message });
        logger?.info('📝 [MultimodalTool] Added text message to request');
      }

      // Process images if provided
      let processedImageCount = 0;
      if (imageUrls && imageUrls.length > 0) {
        logger?.info('📝 [MultimodalTool] Processing images', { count: imageUrls.length });
        
        // Limit to 4 images as specified
        const limitedImageUrls = imageUrls.slice(0, 4);
        
        for (const imageUrl of limitedImageUrls) {
          try {
            logger?.info('📝 [MultimodalTool] Downloading image', { url: imageUrl });
            
            // Download image
            const response = await fetch(imageUrl);
            if (!response.ok) {
              logger?.warn('⚠️ [MultimodalTool] Failed to download image', { 
                url: imageUrl, 
                status: response.status 
              });
              continue;
            }
            
            const imageBuffer = await response.arrayBuffer();
            const base64Image = Buffer.from(imageBuffer).toString('base64');
            
            // Determine mime type from URL or response headers
            let mimeType = response.headers.get('content-type') || 'image/jpeg';
            if (!mimeType.startsWith('image/')) {
              mimeType = 'image/jpeg'; // Default fallback
            }
            
            // Add image in OpenAI format
            content.push({
              type: "image_url",
              image_url: {
                url: `data:${mimeType};base64,${base64Image}`
              }
            });
            
            processedImageCount++;
            logger?.info('✅ [MultimodalTool] Successfully processed image', { 
              url: imageUrl,
              mimeType,
              size: imageBuffer.byteLength 
            });
            
          } catch (error) {
            logger?.error('❌ [MultimodalTool] Error processing image', { 
              url: imageUrl, 
              error: error instanceof Error ? error.message : String(error)
            });
          }
        }
      }

      if (content.length === 0) {
        content.push({ type: "text", text: "Привет! Как дела?" });
      }

      logger?.info('📝 [MultimodalTool] Sending request to Gemini via hubai.loe.gg', { 
        contentCount: content.length,
        processedImages: processedImageCount 
      });

      // Generate content using Gemini 2.5 Flash Image Preview via OpenAI interface
      const result = await generateText({
        model: openai("gemini-2.5-flash-image-preview"),
        messages: [
          {
            role: "user",
            content: content
          }
        ],
        temperature: 0.7,
      });

      logger?.info('✅ [MultimodalTool] Generated response', { 
        responseLength: result.text.length,
        processedImages: processedImageCount
      });

      return {
        response: result.text,
        processedImages: processedImageCount
      };

    } catch (error) {
      logger?.error('❌ [MultimodalTool] Error during processing', { 
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
      
      // Return a fallback response instead of throwing
      return {
        response: `Извините, произошла ошибка при обработке вашего запроса. Попробуйте еще раз.`,
        processedImages: 0
      };
    }
  },
});