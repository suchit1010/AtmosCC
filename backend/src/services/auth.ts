/**
 * ATMOS Auth Service (Sui edition — identical to Solana version)
 * Auth is chain-agnostic: phone OTP + JWT tokens
 */

import crypto from 'crypto';
import { query } from '../db/pool';
import { logger, log } from '../utils/logger';

const JWT_SECRET         = process.env.JWT_SECRET         || 'dev-secret-change-in-production-atmos-sui';
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'dev-refresh-secret-atmos-sui';
const JWT_EXPIRY         = parseInt(process.env.JWT_EXPIRY         || '900');
const JWT_REFRESH_EXPIRY = parseInt(process.env.JWT_REFRESH_EXPIRY || '604800');

function base64url(s: string) {
  return Buffer.from(s).toString('base64').replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
}

function signJWT(payload: object, secret: string, expiresIn: number): string {
  const h = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const b = base64url(JSON.stringify({ ...payload, exp: Math.floor(Date.now()/1000)+expiresIn, iat: Math.floor(Date.now()/1000) }));
  const s = crypto.createHmac('sha256', secret).update(`${h}.${b}`).digest('base64').replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
  return `${h}.${b}.${s}`;
}

export function verifyJWT(token: string, secret = JWT_SECRET): Record<string, any> | null {
  try {
    const [h, b, s] = token.split('.');
    const exp = crypto.createHmac('sha256', secret).update(`${h}.${b}`).digest('base64').replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
    if (s !== exp) return null;
    const p = JSON.parse(Buffer.from(b, 'base64').toString());
    if (p.exp < Math.floor(Date.now()/1000)) return null;
    return p;
  } catch { return null; }
}

const OTP_STORE = new Map<string, { otp: string; expiresAt: number; attempts: number }>();

export async function sendOTP(phone: string, countryCode: string): Promise<{ status: 'sent'; expiresIn: number; devOtp?: string }> {
  const full  = `+${countryCode}${phone.replace(/^0/, '')}`;
  const entry = OTP_STORE.get(`otp:${full}`);
  if (entry && entry.attempts >= 3 && entry.expiresAt > Date.now()) throw new Error('Too many OTP attempts');

  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  OTP_STORE.set(`otp:${full}`, { otp, expiresAt: Date.now() + 300_000, attempts: (entry?.attempts || 0) + 1 });
  setTimeout(() => OTP_STORE.delete(`otp:${full}`), 300_000);

  const sid = process.env.TWILIO_ACCOUNT_SID, tok = process.env.TWILIO_AUTH_TOKEN, from = process.env.TWILIO_PHONE_NUMBER;
  if (sid && tok && from) {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: { 'Authorization': 'Basic ' + Buffer.from(`${sid}:${tok}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ From: from, To: full, Body: `Your ATMOS code: ${otp}. Valid 5 min.` }),
    });
    if (!res.ok) throw new Error(`SMS error: ${await res.text()}`);
  } else {
    logger.warn(`DEV MODE OTP for ${full}: ${otp}`);
  }

  return { status: 'sent', expiresIn: 300, devOtp: sid ? undefined : otp };
}

export async function verifyOTPAndIssueTokens(phone: string, countryCode: string, otp: string, fingerprint: string) {
  const full  = `+${countryCode}${phone.replace(/^0/, '')}`;
  const entry = OTP_STORE.get(`otp:${full}`);
  if (!entry || entry.otp !== otp || entry.expiresAt < Date.now()) throw new Error('Invalid or expired OTP');
  OTP_STORE.delete(`otp:${full}`);

  let user: { id: string; role: string; name: string | null; phone_number?: string };
  try {
    const r = await query<{ id: string; role: string; name: string }>(
      `INSERT INTO users (phone_number, role) VALUES ($1, 'producer')
       ON CONFLICT (phone_number) DO UPDATE SET updated_at = NOW()
       RETURNING id, role, name`, [full]
    );
    user = r.rows[0];
    await query(`INSERT INTO user_devices (user_id, fingerprint, device_name, last_seen)
                 VALUES ($1,$2,'mobile',NOW()) ON CONFLICT (user_id, fingerprint) DO UPDATE SET last_seen = NOW()`,
                [user.id, fingerprint]).catch(() => {});
  } catch {
    logger.warn(`DB unavailable, using mock user for ${full}`);
    user = { id: crypto.createHash('sha256').update(full).digest('hex').slice(0,36), role: 'producer', name: null };
  }

  const p = { sub: user.id, phone: full, role: user.role };
  log.audit('auth.login', user.id, { phone: full.slice(0,-4)+'****' });
  return {
    accessToken:  signJWT(p, JWT_SECRET, JWT_EXPIRY),
    refreshToken: signJWT(p, JWT_REFRESH_SECRET, JWT_REFRESH_EXPIRY),
    user: { id: user.id, phone: full, phone_number: full, role: user.role, name: user.name, kycStatus: 'pending' },
  };
}

export async function refreshAccessToken(refreshToken: string) {
  const p = verifyJWT(refreshToken, JWT_REFRESH_SECRET);
  if (!p) throw new Error('Invalid or expired refresh token');
  return { accessToken: signJWT({ sub: p.sub, phone: p.phone, role: p.role }, JWT_SECRET, JWT_EXPIRY) };
}

export async function getUserById(userId: string) {
  try {
    const r = await query(`SELECT id, phone_number, email, name, organisation, role, kyc_status, wallet_address, sui_address, created_at
                           FROM users WHERE id = $1 LIMIT 1`, [userId]);
    if (!r.rows[0]) return null;
    const u = r.rows[0] as any;
    return { id: u.id, phone: u.phone_number, phone_number: u.phone_number, name: u.name, organisation: u.organisation,
             role: u.role, kycStatus: u.kyc_status, walletAddress: u.sui_address || u.wallet_address, createdAt: u.created_at };
  } catch {
    return { id: userId, phone: '', name: null, role: 'producer', kycStatus: 'pending', walletAddress: null };
  }
}
