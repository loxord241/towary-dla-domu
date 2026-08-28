import type { Metadata } from 'next';
import SiteHeader from '@/app/components/SiteHeader';
import CheckoutForm from './CheckoutForm';

export const metadata: Metadata = {
  title: 'Оформлення замовлення — Товари для дому',
};

export default function CheckoutPage() {
  return (
    <div className="min-h-screen bg-gray-50">
      <SiteHeader />
      <CheckoutForm />
      {/* Footer intentionally omitted on checkout to keep the flow focused */}
    </div>
  );
}
