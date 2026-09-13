'use client';

import type { DeliveryType, PickupPaymentIntent } from '../delivery-apis';

interface LiqPayHintProps {
  deliveryType: DeliveryType | '';
  paymentIntent: PickupPaymentIntent;
}

// LiqPay-подсказка не нужна, когда оформляется самовывоз с
// оплатой наличными на точке. Условие привязано К ДОСТАВКЕ, а не
// только к radio: пользователь мог выбрать готівку, потом
// переключиться на перевозчика — stale intent не должен прятать
// подсказку (аудит P2).
// (Moved verbatim from CheckoutForm.tsx during the 2026-09-13 split.)
export default function LiqPayHint({
  deliveryType,
  paymentIntent,
}: LiqPayHintProps) {
  return (
    <>
      {!(deliveryType === 'pickup' && paymentIntent === 'cash_on_pickup') && (
        <p className="text-xs text-gray-500">
          Після оформлення замовлення ви зможете одразу сплатити його
          онлайн через LiqPay.
        </p>
      )}
    </>
  );
}
