'use client';

import type { Carrier, DeliveryType } from '../delivery-apis';

export const CARRIERS: { value: Carrier; label: string }[] = [
  { value: 'nova_poshta', label: 'Нова Пошта' },
  { value: 'ukrposhta', label: 'Укрпошта' },
  { value: 'pickup', label: 'Самовивіз, Кривий Ріг' },
];

// The ONLY place the carrier → service_type mapping lives. Keep in sync
// with SERVICE_TYPES in app/lib/checkout-delivery.ts (Ukrposhta exposes
// office delivery only — deliberately no courier branch).
const CARRIER_SERVICE_TYPES: Record<
  Carrier,
  { value: DeliveryType; label: string }[]
> = {
  nova_poshta: [
    { value: 'nova_poshta_warehouse', label: 'Відділення' },
    { value: 'nova_poshta_locker', label: 'Поштомат' },
    { value: 'nova_poshta_courier', label: 'Кур’єр' },
  ],
  ukrposhta: [{ value: 'ukrposhta_warehouse', label: 'Відділення' }],
  pickup: [{ value: 'pickup', label: 'Заберу сам' }],
};

interface DeliveryCarrierPickerProps {
  carrier: Carrier | '';
  deliveryType: DeliveryType | '';
  toggleCarrier: (next: Carrier) => void;
  applyServiceType: (t: DeliveryType) => void;
}

// Carrier blocks + their service-type buttons (moved verbatim from
// CheckoutForm.tsx during the 2026-09-13 mechanical split).
export default function DeliveryCarrierPicker({
  carrier,
  deliveryType,
  toggleCarrier,
  applyServiceType,
}: DeliveryCarrierPickerProps) {
  // Two carrier blocks; the chosen one reveals its service-type
  // buttons directly underneath. aria-pressed marks the visible
  // selection, aria-expanded the disclosure.
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 items-start gap-2 mb-4">
      {CARRIERS.map((c) => {
        const selected = carrier === c.value;
        return (
          <div
            key={c.value}
            className={`rounded-lg border p-3 transition-colors motion-reduce:transition-none ${
              selected
                ? 'border-blue-600 ring-1 ring-blue-600'
                : 'border-gray-300'
            }`}
          >
            <button
              type="button"
              onClick={() => toggleCarrier(c.value)}
              aria-pressed={selected}
              aria-expanded={selected}
              aria-controls={
                selected ? `carrier-services-${c.value}` : undefined
              }
              className={`min-h-[44px] w-full rounded-md px-1 py-2.5 text-left text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
                selected ? 'text-blue-700' : 'text-gray-700'
              }`}
            >
              <span className="flex items-center justify-between">
                {c.label}
                <span
                  aria-hidden="true"
                  className="text-xs text-gray-500"
                >
                  {selected ? '▴' : '▾'}
                </span>
              </span>
            </button>
            {/* Service buttons render under the expanded carrier,
                a step below its block. The disclosure animates with
                the CSS grid-rows trick: the wrapper is always
                mounted and its single row interpolates 0fr <-> 1fr.
                `visibility` is transitioned too — per CSS
                transitions it stays visible for the whole collapse
                (flips to hidden at the end) and is visible from the
                start on expand — so collapsed buttons leave the tab
                order / a11y tree without JS measurement. */}
            <div
              id={`carrier-services-${c.value}`}
              className={`grid transition-[grid-template-rows,visibility] duration-200 ease-out motion-reduce:transition-none ${
                selected
                  ? 'grid-rows-[1fr] visible'
                  : 'grid-rows-[0fr] invisible'
              }`}
            >
              <div className="min-h-0 overflow-hidden">
                <div className="mt-2 flex flex-wrap gap-2">
                  {CARRIER_SERVICE_TYPES[c.value].map((t) => (
                    <button
                      key={t.value}
                      type="button"
                      onClick={() => applyServiceType(t.value)}
                      aria-pressed={deliveryType === t.value}
                      className={`min-h-[44px] rounded-md border px-3 py-2 text-sm transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
                        deliveryType === t.value
                          ? 'border-blue-600 bg-blue-50 font-medium text-blue-700'
                          : 'border-gray-300 bg-white text-gray-700 hover:border-gray-400'
                      }`}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
