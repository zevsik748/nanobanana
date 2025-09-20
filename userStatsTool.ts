import { createTool } from "@mastra/core/tools";
import type { IMastraLogger } from "@mastra/core/logger";
import { z } from "zod";
import { 
  getUserDailyCount, 
  getUserImageHistory,
  upsertUser,
  isAdminUser 
} from "../../../server/storage";
import { db, schema } from "../../../server/storage";
import { eq, count } from "drizzle-orm";

export const userStatsTool = createTool({
  id: "user-stats-tool",
  description: "Get comprehensive user statistics from database including daily image count, total generations, and last reset date. Shows user's usage patterns and history.",
  inputSchema: z.object({
    user_id: z.string().describe("Telegram user ID to get statistics for"),
    username: z.string().optional().describe("Username to update in database if provided"),
  }),
  outputSchema: z.object({
    success: z.boolean().describe("Whether statistics were retrieved successfully"),
    daily_count: z.number().describe("Number of images generated today"),
    total_count: z.number().describe("Total number of images ever generated"),
    last_reset_date: z.string().describe("Date when daily counter was last reset (YYYY-MM-DD format)"),
    remaining_daily: z.number().describe("Remaining images available today (15 - daily_count, or 999999 for admins)"),
    recent_generations: z.array(z.object({
      id: z.number(),
      prompt: z.string(),
      created_at: z.string(),
    })).describe("Last 5 image generations with details"),
    message: z.string().describe("Formatted statistics message for the user"),
  }),
  execute: async ({ context: { user_id, username }, mastra }) => {
    const logger = mastra?.getLogger();
    
    logger?.info('🔧 [UserStatsTool] Getting user statistics', { 
      user_id,
      username 
    });

    try {
      logger?.info('📝 [UserStatsTool] Ensuring user exists in database');

      // Ensure user exists in database (create if not exists, update username if provided)
      await upsertUser(user_id, username || `user_${user_id}`);

      logger?.info('📝 [UserStatsTool] Getting daily count');

      // Get user's daily count
      const dailyCount = await getUserDailyCount(user_id);

      logger?.info('📝 [UserStatsTool] Getting total count from database');

      // Get total count of all user's image generations
      const [totalResult] = await db
        .select({ count: count() })
        .from(schema.image_generations)
        .where(eq(schema.image_generations.user_id, user_id));

      const totalCount = totalResult?.count || 0;

      logger?.info('📝 [UserStatsTool] Getting user data for reset date');

      // Get user data for last reset date
      const [user] = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.user_id, user_id));

      const lastResetDate = user?.last_reset_date || new Date().toISOString().split('T')[0];

      logger?.info('📝 [UserStatsTool] Getting recent generations');

      // Get recent generations (last 5)
      const recentGenerations = await getUserImageHistory(user_id, 5);

      // Check if user is admin
      const isAdmin = isAdminUser(user_id);
      
      // Calculate remaining daily images
      const remainingDaily = isAdmin ? 999999 : Math.max(0, 15 - dailyCount);
      const dailyLimit = isAdmin ? "∞" : "15";

      // Format recent generations for output
      const formattedGenerations = recentGenerations.map(gen => ({
        id: gen.id,
        prompt: gen.prompt.length > 50 ? gen.prompt.substring(0, 50) + "..." : gen.prompt,
        created_at: gen.created_at.toISOString(),
      }));

      // Create formatted message
      const adminBadge = isAdmin ? "👑 *АДМИНИСТРАТОР* 👑\n" : "";
      const limitDisplay = isAdmin ? "∞ (безлимитно)" : remainingDaily.toString();
      
      const message = `📊 *Ваша статистика:*
${adminBadge}
🔸 *За сегодня:* ${dailyCount}/${dailyLimit} изображений
🔸 *Осталось сегодня:* ${limitDisplay} изображений
🔸 *Всего сгенерировано:* ${totalCount} изображений
🔸 *Последний сброс:* ${lastResetDate}

${recentGenerations.length > 0 ? `🎨 *Последние генерации:*
${recentGenerations.slice(0, 3).map((gen, i) => 
  `${i + 1}. ${gen.prompt.length > 40 ? gen.prompt.substring(0, 40) + "..." : gen.prompt}`
).join('\n')}` : ''}

💡 ${isAdmin ? "Вам доступна безлимитная генерация!" : "Лимит сбрасывается каждый день в 00:00 UTC"}`;

      logger?.info('✅ [UserStatsTool] Statistics retrieved successfully', {
        user_id,
        daily_count: dailyCount,
        total_count: totalCount,
        remaining_daily: remainingDaily,
        recent_count: recentGenerations.length
      });

      return {
        success: true,
        daily_count: dailyCount,
        total_count: totalCount,
        last_reset_date: lastResetDate,
        remaining_daily: remainingDaily,
        recent_generations: formattedGenerations,
        message: message
      };

    } catch (error) {
      logger?.error('❌ [UserStatsTool] Error getting user statistics', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        user_id
      });

      return {
        success: false,
        daily_count: 0,
        total_count: 0,
        last_reset_date: new Date().toISOString().split('T')[0],
        remaining_daily: 50,
        recent_generations: [],
        message: "❌ Не удалось получить статистику. Попробуйте позже."
      };
    }
  },
});