import {
  upsertUser,
  getUserDailyCount,
  incrementUserImageCount,
  saveImageGeneration,
  getUserImageHistory,
  hasReachedDailyLimit,
} from './server/storage';

async function testDatabase() {
  console.log('🧪 Testing database functionality...');

  try {
    // Тест 1: Создание или обновление пользователя
    console.log('\n1️⃣ Testing user creation...');
    const user = await upsertUser('123456789', 'test_user');
    console.log('✅ User created:', user);

    // Тест 2: Получение текущего счетчика изображений
    console.log('\n2️⃣ Testing daily count...');
    const dailyCount = await getUserDailyCount('123456789');
    console.log('✅ Daily count:', dailyCount);

    // Тест 3: Проверка лимита
    console.log('\n3️⃣ Testing daily limit check...');
    const hasReachedLimit = await hasReachedDailyLimit('123456789');
    console.log('✅ Has reached daily limit:', hasReachedLimit);

    // Тест 4: Сохранение генерации изображения
    console.log('\n4️⃣ Testing image generation save...');
    const generation = await saveImageGeneration(
      '123456789',
      'A beautiful sunset over mountains',
      'https://example.com/image.jpg'
    );
    console.log('✅ Image generation saved:', generation);

    // Тест 5: Увеличение счетчика
    console.log('\n5️⃣ Testing counter increment...');
    const updatedUser = await incrementUserImageCount('123456789');
    console.log('✅ Counter incremented:', updatedUser);

    // Тест 6: Получение истории
    console.log('\n6️⃣ Testing image history...');
    const history = await getUserImageHistory('123456789', 5);
    console.log('✅ Image history:', history);

    console.log('\n🎉 All tests completed successfully!');
  } catch (error) {
    console.error('❌ Test failed:', error);
  }
}

// Запуск тестов только если файл выполняется напрямую
if (import.meta.url === `file://${process.argv[1]}`) {
  testDatabase();
}

export { testDatabase };