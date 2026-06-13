import type { FastifyRequest, FastifyReply } from 'fastify';
import { verifyJWT } from '../services/auth';

export interface AuthUser { sub: string; phone: string; role: string; }

declare module 'fastify' {
  interface FastifyRequest { user?: AuthUser; }
}

export async function authMiddleware(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) { reply.status(401).send({ error: 'Missing authorization' }); return; }
  const payload = verifyJWT(auth.substring(7));
  if (!payload) { reply.status(401).send({ error: 'Invalid or expired token' }); return; }
  req.user = { sub: payload.sub, phone: payload.phone, role: payload.role };
}
