import { Agent } from "@mastra/core/agent";
import { Memory } from "@mastra/memory";
import { sharedPostgresStorage } from "../storage";
import { createOpenAI } from "@ai-sdk/openai";
import { multimodalTool } from "../tools/multimodalTool";
import { geminiImageGenerationTool } from "../tools/geminiImageGenerationTool";
import { subscriptionCheckTool } from "../tools/subscriptionCheckTool";

// Initialize hubai.loe.gg через OpenAI-совместимый интерфейс для gemini-2.5-flash-image-preview
const hubai = createOpenAI({
  apiKey: process.env.HUBAI_API_KEY!,
  baseURL: 'https://hubai.loe.gg/v1',
});

// Initialize основной агент через OpenAI для function calling
const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

export const telegramBot = new Agent({
  name: "AI Image Generator Telegram Bot", 
  instructions: `Ты бот Nano Banano для генерации изображений через Gemini 2.5 Flash Image Preview.

ВОЗМОЖНОСТИ:
- 🎨 Генерация по тексту: используй geminiImageGenerationTool
- 🖼️ Генерация по фото: используй geminiImageGenerationTool с source_images
- 👁️ Анализ фото: используй multimodalTool

РАБОТА С ИЗОБРАЖЕНИЯМИ:
- Если пользователь прислал фото + текст = используй geminiImageGenerationTool с source_images
- Если только текст = используй geminiImageGenerationTool без source_images  
- Если только фото или вопрос о фото = используй multimodalTool

Отвечай кратко по-русски.`,
  
  model: openai("gpt-4o"),
  
  tools: {
    multimodalTool,
    geminiImageGenerationTool,
    subscriptionCheckTool,
  },
  
  memory: new Memory({
    options: {
      threads: {
        generateTitle: false,
      },
      lastMessages: 2,
    },
    storage: sharedPostgresStorage,
  }),
});