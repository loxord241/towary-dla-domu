/**
 * Telegram order notification CLI — explicit, manual-only tooling.
 *
 *   node scripts/telegram-order-notification.ts --dry-run
 *       Builds the notification message from a FIXED fictitious test payload
 *       and prints a preview. No DB access, no network, no secrets required.
 *
 *   node scripts/telegram-order-notification.ts --send-test
 *       Sends the SAME fictitious test message through the real Telegram
 *       Bot API. NEVER run automatically; requires TELEGRAM_BOT_TOKEN and
 *       TELEGRAM_ORDER_CHAT_ID. No production order is used or created.
 *
 *   node scripts/telegram-order-notification.ts --check-config
 *       Reports whether notifications are enabled (env presence only —
 *       values are never printed).
 *
 * Exit codes: 0 = ok, 1 = misconfigured / send failure, 2 = usage error.
 */

import {
  buildOrderNotificationMessage,
  resolveTelegramOrderConfig,
  sendTelegramOrderMessage,
  type OrderNotificationData,
} from '../app/lib/notifications/telegram.ts';

// Fully fictitious payload — including Telegram special characters to prove
// plain text stays intact. Resembles no real order; safe to print anywhere.
const TEST_DATA: OrderNotificationData = {
  orderId: '00000000-0000-0000-0000-000000000000',
  orderNumber: 'TEST-000000',
  total: 1299,
  currency: 'UAH',
  customerName: 'Тест Тестовий <b>не_реальний</b> *клієнт*',
  customerPhone: '+380000000000',
  customerEmail: 'test@example.com',
  paymentMethod: null,
  delivery: {
    serviceType: 'nova_poshta_warehouse',
    settlementName: 'Київ (тест)',
    divisionName: 'Відділення № 1 (тест)',
  },
  items: [
    {
      name: 'Праска TEFAL FV2C41E0 [тест] *_інжекція_*',
      variantName: 'Колір: білий',
      sku: 'TEST-SKU-1',
      quantity: 1,
      price: 1199,
      total: 1199,
    },
    {
      name: 'Чайник KETTLE-2 (тест) & інжекція',
      variantName: null,
      sku: 'TEST-SKU-2',
      quantity: 2,
      price: 50,
      total: 100,
    },
  ],
};

const args = process.argv.slice(2);

if (args.includes('--check-config')) {
  const config = resolveTelegramOrderConfig();
  console.log(
    config.enabled
      ? 'Telegram notifications: enabled (both env vars present; values not shown)'
      : 'Telegram notifications: disabled (TELEGRAM_BOT_TOKEN and/or TELEGRAM_ORDER_CHAT_ID missing)'
  );
  process.exit(0);
}

if (args.includes('--dry-run')) {
  const message = buildOrderNotificationMessage(TEST_DATA);
  console.log('--- DRY-RUN message preview (fictitious data, nothing sent) ---');
  console.log(message);
  console.log('--- end of preview ---');
  process.exit(0);
}

if (args.includes('--send-test')) {
  const config = resolveTelegramOrderConfig();
  if (!config.enabled) {
    console.error(
      'Telegram notifications: disabled — set TELEGRAM_BOT_TOKEN and TELEGRAM_ORDER_CHAT_ID first.'
    );
    process.exit(1);
  }
  console.log('Sending fictitious test message via real Telegram API…');
  const result = await sendTelegramOrderMessage(TEST_DATA, config);
  if (result.sent) {
    console.log('Test message sent (check the configured chat).');
    process.exit(0);
  }
  console.error(`Test message NOT sent: ${result.reason ?? 'unknown'}`);
  process.exit(1);
}

console.error('Usage: node scripts/telegram-order-notification.ts [--dry-run | --send-test | --check-config]');
process.exit(2);
