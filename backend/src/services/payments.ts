/**
 * ATMOS Payment Service — Dodo Payments (chain-agnostic)
 * Identical to Solana version — Dodo handles fiat, chain-independent
 */

import { query, transaction } from '../db/pool';
import { logger, log }        from '../utils/logger';
import crypto                 from 'crypto';

const DODO_URL    = process.env.DODO_API_URL         || 'https://api.dodopayments.com/v1';
const DODO_KEY    = process.env.DODO_API_KEY         || '';
const DODO_SECRET = process.env.DODO_WEBHOOK_SECRET  || 'dev-webhook-secret';

export async function createPaymentIntent(buyerId: string, listingId: string, quantity: number) {
  const listingRes = await query(
    `SELECT ml.*, cc.amount_co2e, cc.grade, p.name as project_name, u.name as seller_name
     FROM marketplace_listings ml
     JOIN carbon_credits cc ON cc.id = ml.credit_id
     JOIN projects p ON p.id = cc.project_id
     JOIN users u ON u.id = ml.seller_id
     WHERE ml.id = $1 AND ml.status = 'active'`, [listingId]
  );
  if (listingRes.rows.length === 0) throw new Error('Listing not found');

  const listing    = listingRes.rows[0];
  const totalInr   = parseFloat(listing.unit_price_inr) * quantity * 1.015; // 1.5% fee
  const expiresAt  = new Date(Date.now() + 30 * 60 * 1000);
  let sessionId    = '';
  let checkoutUrl  = '';

  if (DODO_KEY) {
    try {
      const res = await fetch(`${DODO_URL}/payment-intents`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${DODO_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: Math.round(totalInr * 100), currency: 'INR', description: `Carbon Credits: ${listing.project_name}`, metadata: { buyerId, listingId, quantity }, expires_at: expiresAt.toISOString() }),
      });
      if (res.ok) { const d = await res.json() as any; sessionId = d.session_id || d.id; checkoutUrl = d.checkout_url || d.url; }
    } catch (err: any) { logger.warn('Dodo unreachable', { error: err.message }); }
  }

  if (!sessionId) {
    sessionId   = 'mock_' + crypto.randomBytes(8).toString('hex');
    checkoutUrl = `https://checkout.dodopayments.com/mock/${sessionId}`;
  }

  await query(
    `INSERT INTO payment_intents (dodo_session_id, buyer_id, listing_id, amount_inr, quantity, status, checkout_url, expires_at)
     VALUES ($1,$2,$3,$4,$5,'pending',$6,$7)`,
    [sessionId, buyerId, listingId, totalInr, quantity, checkoutUrl, expiresAt]
  );

  return { sessionId, checkoutUrl, expiresAt, amountInr: totalInr };
}

export async function handleWebhook(rawBody: string, signature: string) {
  const expected = crypto.createHmac('sha256', DODO_SECRET).update(rawBody).digest('hex');
  if (signature !== expected && signature !== `sha256=${expected}` && process.env.NODE_ENV === 'production') {
    throw new Error('Invalid webhook signature');
  }

  const { event_type, data } = JSON.parse(rawBody);
  logger.info('Dodo webhook', { event_type });

  if (event_type === 'payment_intent.succeeded' || event_type === 'payment.completed') {
    await onPaymentSuccess(data);
    return { received: true, action: 'payment_processed' };
  }
  if (event_type === 'payment_intent.failed') {
    await query(`UPDATE payment_intents SET status = 'failed' WHERE dodo_session_id = $1`, [data.session_id || data.id]).catch(() => {});
  }
  return { received: true, action: 'ignored' };
}

async function onPaymentSuccess(data: any) {
  const sessionId = data.session_id || data.id;
  const intentRes = await query(`SELECT * FROM payment_intents WHERE dodo_session_id = $1`, [sessionId]);
  if (!intentRes.rows[0] || intentRes.rows[0].status === 'succeeded') return;

  const intent = intentRes.rows[0];
  await transaction(async (client) => {
    await client.query(`UPDATE payment_intents SET status = 'succeeded', completed_at = NOW() WHERE dodo_session_id = $1`, [sessionId]);
    const creditRes = await client.query(`SELECT credit_id FROM marketplace_listings WHERE id = $1`, [intent.listing_id]);
    const creditId  = creditRes.rows[0]?.credit_id;
    if (creditId) {
      await client.query(`INSERT INTO user_portfolio (user_id, credit_id, quantity, buy_price, source) VALUES ($1,$2,$3,$4,'purchased') ON CONFLICT (user_id, credit_id) DO UPDATE SET quantity = user_portfolio.quantity + $3`, [intent.buyer_id, creditId, intent.quantity, intent.amount_inr / intent.quantity]);
      await client.query(`UPDATE carbon_credits SET status = 'sold' WHERE id = $1`, [creditId]);
      await client.query(`UPDATE marketplace_listings SET status = 'sold', sold_at = NOW() WHERE id = $1`, [intent.listing_id]);
    }
  });
}

export async function simulatePaymentSuccess(sessionId: string) {
  await onPaymentSuccess({ session_id: sessionId });
}

export async function getPaymentStatus(sessionId: string, buyerId: string) {
  const r = await query(`SELECT pi.*, ml.quantity as listing_qty FROM payment_intents pi LEFT JOIN marketplace_listings ml ON ml.id = pi.listing_id WHERE pi.dodo_session_id = $1 AND pi.buyer_id = $2`, [sessionId, buyerId]);
  return r.rows[0] || null;
}
