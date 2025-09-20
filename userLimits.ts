import { Pool } from 'pg';

interface UserLimitResult {
  canGenerate: boolean;
  dailyCount: number;
  remaining: number;
  isAdmin: boolean;
  limitReached: boolean;
  message?: string;
}

const DAILY_LIMIT_PRIVATE = 3; // 3 запроса в день для приватных чатов
const DAILY_LIMIT_GROUP = 30; // 30 запросов в день для групповых чатов
const ADMIN_USER_ID = "6913446846"; // dmitriy_ferixdi - неограниченный доступ

// Пул соединений для повторного использования
let dbPool: Pool | null = null;

function getDbPool(): Pool {
  if (!dbPool) {
    dbPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 10, // максимум соединений
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    });
  }
  return dbPool;
}

/**
 * Атомарно резервирует слот для генерации (check + increment в одной операции)
 * Предотвращает race conditions и гарантирует не более 5 изображений в день
 */
export async function reserveGenerationSlot(
  userId: string,
  username: string,
  chatType: string = "private" // "private", "group", "supergroup", "channel"
): Promise<UserLimitResult> {
  const pool = getDbPool();
  const client = await pool.connect();
  
  try {
    console.log('🎯 [UserLimits] Reserving generation slot for user', { userId, username });

    // Проверка админа
    const isAdmin = userId === ADMIN_USER_ID;
    if (isAdmin) {
      console.log('👑 [UserLimits] Admin user detected - unlimited access', { userId });
      return {
        canGenerate: true,
        dailyCount: 0,
        remaining: 999,
        isAdmin: true,
        limitReached: false,
        message: "Администратор - безлимитный доступ"
      };
    }

    // Выбираем лимит в зависимости от типа чата
    const dailyLimit = (chatType === "private") ? DAILY_LIMIT_PRIVATE : DAILY_LIMIT_GROUP;
    console.log('📊 [UserLimits] Using daily limit', { userId, chatType, dailyLimit });

    // Упрощенный подход: две отдельные операции в одной транзакции
    // Шаг 1: Создать/обновить пользователя с правильным сбросом счетчика
    await client.query(`
      INSERT INTO users (user_id, username, daily_image_count, last_reset_date)
      VALUES ($1, $2, 0, CURRENT_DATE)
      ON CONFLICT (user_id) DO UPDATE SET
        username = EXCLUDED.username,
        daily_image_count = CASE 
          WHEN users.last_reset_date < CURRENT_DATE THEN 0
          ELSE users.daily_image_count
        END,
        last_reset_date = CASE 
          WHEN users.last_reset_date < CURRENT_DATE THEN CURRENT_DATE
          ELSE users.last_reset_date
        END;
    `, [userId, username]);

    // Шаг 2: Попытаться зарезервировать слот (увеличить счетчик)
    const result = await client.query(`
      UPDATE users 
      SET daily_image_count = daily_image_count + 1
      WHERE user_id = $1 
        AND daily_image_count < $2
      RETURNING daily_image_count as final_count;
    `, [userId, dailyLimit]);

    const queryResult = result.rows[0];
    const slotReserved = queryResult ? true : false; // Если запрос обновил строку, значит слот зарезервирован
    const finalCount = queryResult ? queryResult.final_count : dailyLimit; // Если не удалось зарезервировать, значит лимит достигнут
    
    if (!slotReserved) {
      console.log('❌ [UserLimits] Failed to reserve slot - limit reached', { 
        userId, 
        finalCount, 
        limit: dailyLimit 
      });
      
      return {
        canGenerate: false,
        dailyCount: finalCount,
        remaining: 0,
        isAdmin: false,
        limitReached: true,
        message: chatType === "private" ?
          `🎯 *Тестовый период закончен!* Вы использовали ${dailyLimit} бесплатных генерации.\n\n💳 *Для получения безлимитных генераций:*\n• Оплатите по СБП: *89935801642* (Альфа Банк, Дмитрий)\n• Отправьте скриншот платежки @dmitriy_ferixdi\n\n🎁 *Участники общей подписки получают доступ бесплатно и безлимитно!*\n\n✨ После оплаты получите неограниченный доступ!` :
          `💰 *Лимит группового чата исчерпан!* Использовано ${dailyLimit} генераций.\n\n🔄 Лимит обновится завтра в 00:00 МСК.\n\n💬 Личные сообщения: ${DAILY_LIMIT_PRIVATE} изображений/день`
      };
    }

    const remaining = Math.max(0, dailyLimit - finalCount);

    console.log('✅ [UserLimits] Slot reserved successfully', { 
      userId, 
      finalCount, 
      remaining,
      limit: dailyLimit 
    });
    
    return {
      canGenerate: true,
      dailyCount: finalCount,
      remaining,
      isAdmin: false,
      limitReached: false,
      message: remaining > 0 
        ? `Слот зарезервирован! Осталось ${remaining} из ${dailyLimit} запросов на сегодня.`
        : `Слот зарезервирован! Это ваш последний запрос на сегодня.`
    };

  } catch (error) {
    console.error('❌ [UserLimits] Database error:', error);
    
    // В случае ошибки БД ЗАПРЕЩАЕМ генерацию для безопасности
    return {
      canGenerate: false,
      dailyCount: 0,
      remaining: 0,
      isAdmin: false,
      limitReached: true,
      message: "❌ Ошибка резервирования слота. Попробуйте позже."
    };
  } finally {
    client.release();
  }
}

/**
 * Уменьшает счетчик в случае неудачной генерации (возвращает зарезервированный слот)
 */
export async function releaseReservedSlot(userId: string): Promise<void> {
  const pool = getDbPool();
  const client = await pool.connect();
  
  try {
    console.log('↩️ [UserLimits] Releasing reserved slot due to generation failure', { userId });

    // Проверка админа
    const isAdmin = userId === ADMIN_USER_ID;
    if (isAdmin) {
      return; // Админ не использует слоты
    }

    // Атомарное уменьшение счетчика на 1
    const result = await client.query(`
      UPDATE users 
      SET daily_image_count = GREATEST(daily_image_count - 1, 0)
      WHERE user_id = $1 
        AND last_reset_date = CURRENT_DATE 
        AND daily_image_count > 0
      RETURNING daily_image_count;
    `, [userId]);

    if (result.rows.length > 0) {
      console.log('✅ [UserLimits] Reserved slot released', { 
        userId, 
        newCount: result.rows[0].daily_image_count 
      });
    } else {
      console.log('⚠️ [UserLimits] Could not release slot - user not found or count already 0', { userId });
    }

  } catch (error) {
    console.error('❌ [UserLimits] Error releasing reserved slot:', error);
  } finally {
    client.release();
  }
}

/**
 * Получение статистики пользователя без изменения счетчиков
 */
export async function getUserStats(userId: string, chatType: string = "private"): Promise<UserLimitResult | null> {
  const pool = getDbPool();
  const client = await pool.connect();
  
  try {
    const isAdmin = userId === ADMIN_USER_ID;
    if (isAdmin) {
      return {
        canGenerate: true,
        dailyCount: 0,
        remaining: 999,
        isAdmin: true,
        limitReached: false,
        message: "Администратор - безлимитный доступ"
      };
    }

    const result = await client.query(`
      SELECT user_id, username, 
        CASE 
          WHEN last_reset_date < CURRENT_DATE THEN 0
          ELSE daily_image_count
        END as current_count
      FROM users 
      WHERE user_id = $1;
    `, [userId]);
    
    if (result.rows.length === 0) {
      return null;
    }

    // Выбираем лимит в зависимости от типа чата
    const dailyLimit = (chatType === "private") ? DAILY_LIMIT_PRIVATE : DAILY_LIMIT_GROUP;
    
    const currentCount = result.rows[0].current_count;
    const remaining = Math.max(0, dailyLimit - currentCount);
    const limitReached = currentCount >= dailyLimit;
    
    return {
      canGenerate: !limitReached,
      dailyCount: currentCount,
      remaining,
      isAdmin: false,
      limitReached,
      message: limitReached 
        ? `Превышен дневной лимит! Использовано ${currentCount}/${dailyLimit} запросов.`
        : `Использовано ${currentCount}/${dailyLimit} запросов. Осталось: ${remaining}`
    };

  } catch (error) {
    console.error('❌ [UserLimits] Error getting user stats:', error);
    return null;
  } finally {
    client.release();
  }
}