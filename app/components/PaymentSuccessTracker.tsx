'use client';

import { useEffect } from 'react';
import { track } from '@vercel/analytics';
import {
  ANALYTICS_EVENTS,
  PAID_ORDERS_STORAGE_KEY,
  shouldFirePaymentSuccess,
} from '@/app/lib/analytics';

/**
 * payment_success tracker. Renders nothing.
 *
 * The server component (app/checkout/success/page.tsx) reads the order from
 * the database and passes the confirmed payment status here — merely
 * opening the success URL never triggers the event. Fired at most once
 * per order number (localStorage-only dedupe) and carries NO payload:
 * no order numbers, totals, items or contacts leave the browser.
 */
export default function PaymentSuccessTracker({
  paid,
  orderNumber,
}: {
  paid: boolean;
  orderNumber: string;
}) {
  useEffect(() => {
    if (!paid || !orderNumber) return;

    const read = (): string | null => {
      try {
        return window.localStorage.getItem(PAID_ORDERS_STORAGE_KEY);
      } catch {
        return null;
      }
    };
    const write = (value: string): void => {
      try {
        window.localStorage.setItem(PAID_ORDERS_STORAGE_KEY, value);
      } catch {
        // dedupe unavailable — server-side confirmation still holds
      }
    };

    if (shouldFirePaymentSuccess(read, write, orderNumber)) {
      track(ANALYTICS_EVENTS.PAYMENT_SUCCESS);
    }
  }, [paid, orderNumber]);

  return null;
}
