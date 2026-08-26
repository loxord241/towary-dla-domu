/**
 * Unit tests for LiqPay server-side configuration helpers.
 * Env is stubbed per-test BEFORE import via save/restore.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.LIQPAY_PUBLIC_KEY = 'pub';
process.env.LIQPAY_PRIVATE_KEY = 'priv';
delete process.env.LIQPAY_SANDBOX;
delete process.env.NEXT_PUBLIC_SITE_URL;

const {
  LIQPAY_CHECKOUT_URL,
  getLiqPayConfig,
  isLiqPayConfigured,
  buildCallbackUrl,
  buildResultUrl,
} = await import('../app/lib/payment/liqpay-config.ts');

test('CONFIG: checkout URL is the official LiqPay v3 endpoint', () => {
  assert.equal(LIQPAY_CHECKOUT_URL, 'https://www.liqpay.ua/api/3/checkout');
});

test('CONFIG: returns public/private key pair and sandbox=false by default', () => {
  delete process.env.LIQPAY_SANDBOX;
  const c = getLiqPayConfig();
  assert.equal(c.publicKey, 'pub');
  assert.equal(c.privateKey, 'priv');
  assert.equal(c.sandbox, false);
});

test('CONFIG: sandbox flag enabled only via LIQPAY_SANDBOX=1', () => {
  const prevPub = process.env.LIQPAY_PUBLIC_KEY;
  try {
    // sandbox mode requires a sandbox_-prefixed public key (cross-check)
    process.env.LIQPAY_PUBLIC_KEY = 'sandbox_pub';
    process.env.LIQPAY_SANDBOX = '1';
    assert.equal(getLiqPayConfig().sandbox, true);
    process.env.LIQPAY_PUBLIC_KEY = 'pub';
    process.env.LIQPAY_SANDBOX = '0';
    assert.equal(getLiqPayConfig().sandbox, false);
  } finally {
    process.env.LIQPAY_PUBLIC_KEY = prevPub;
    delete process.env.LIQPAY_SANDBOX;
  }
});

test('CONFIG: throws a typed error when keys are missing', () => {
  const prevPub = process.env.LIQPAY_PUBLIC_KEY;
  const prevPriv = process.env.LIQPAY_PRIVATE_KEY;
  try {
    delete process.env.LIQPAY_PUBLIC_KEY;
    assert.throws(() => getLiqPayConfig(), /LIQPAY_PUBLIC_KEY/);
    process.env.LIQPAY_PUBLIC_KEY = prevPub;
    delete process.env.LIQPAY_PRIVATE_KEY;
    assert.throws(() => getLiqPayConfig(), /LIQPAY_PRIVATE_KEY/);
  } finally {
    process.env.LIQPAY_PUBLIC_KEY = prevPub;
    process.env.LIQPAY_PRIVATE_KEY = prevPriv;
  }
});

test('CONFIG: isLiqPayConfigured never throws', () => {
  const prevPriv = process.env.LIQPAY_PRIVATE_KEY;
  try {
    assert.equal(isLiqPayConfigured(), true);
    delete process.env.LIQPAY_PRIVATE_KEY;
    assert.equal(isLiqPayConfigured(), false);
  } finally {
    process.env.LIQPAY_PRIVATE_KEY = prevPriv;
  }
});

test('CONFIG: callback URL from NEXT_PUBLIC_SITE_URL with trailing-slash tolerance', () => {
  const prev = process.env.NEXT_PUBLIC_SITE_URL;
  try {
    process.env.NEXT_PUBLIC_SITE_URL = 'https://shop.example.ua/';
    assert.equal(
      buildCallbackUrl(),
      'https://shop.example.ua/api/payment/liqpay/callback'
    );
    delete process.env.NEXT_PUBLIC_SITE_URL;
    assert.equal(buildCallbackUrl(), 'http://localhost:3000/api/payment/liqpay/callback');
  } finally {
    if (prev === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
    else process.env.NEXT_PUBLIC_SITE_URL = prev;
  }
});

test('CONFIG: result URL is the checkout success page capability pair', () => {
  process.env.NEXT_PUBLIC_SITE_URL = 'https://shop.example.ua';
  assert.equal(
    buildResultUrl('ORD-20260826-ABC123', 'tok123'),
    'https://shop.example.ua/checkout/success?order=ORD-20260826-ABC123&t=tok123'
  );
  delete process.env.NEXT_PUBLIC_SITE_URL;
});
