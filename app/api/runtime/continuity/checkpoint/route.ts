import { z } from 'zod';
import { coordinateContinuityCheckpoint } from '@/app/lib/continuity-service';
import {
  ContinuityPacketV2Schema,
  compileContinuityPacketFromMessages,
  parseContinuityPacketV2,
} from '@/app/lib/continuity-packet';
import { parseJsonBody, routeErrorResponse, routeSuccessResponse, secureRequest } from '@/app/lib/http';
import { RATE_LIMITS } from '@/app/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ROUTE = 'runtime.continuity.checkpoint';

const MessageSchema = z.object({
  role: z.string().trim().min(1).max(80),
  content: z.unknown(),
  name: z.string().trim().max(200).optional(),
  tool_call_id: z.string().trim().max(500).optional(),
});

const RequestSchema = z.object({
  sessionId: z.string().trim().min(1).max(220),
  turnId: z.string().trim().min(1).max(220).optional(),
  namespace: z.string().trim().min(1).max(120).default('zenos'),
  estimatedTokens: z.number().int().nonnegative().max(10_000_000),
  checkpointSoftLimitTokens: z.number().int().min(24_000).max(1_000_000).default(160_000),
  continuityPacket: ContinuityPacketV2Schema.optional(),
  messages: z.array(MessageSchema).max(400).default([]),
  maxChars: z.number().int().min(1_000).max(24_000).default(8_000),
  inputMaxChars: z.number().int().min(20_000).max(500_000).default(120_000),
  forceCheckpoint: z.boolean().default(false),
  reason: z.string().trim().min(1).max(500).default('hermes-compression-boundary'),
}).superRefine((value, context) => {
  if (!value.continuityPacket && value.messages.length < 1) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['continuityPacket'],
      message: 'A ContinuityPacket v2 or at least one source message is required',
    });
  }
});

export async function POST(req: Request) {
  const secured = await secureRequest(req, {
    scope: 'runtime:run',
    rateLimit: RATE_LIMITS.write,
    maxBodyBytes: 600_000,
    routeName: ROUTE,
  });
  if (!secured.ok) return secured.response;
  try {
    const body = await parseJsonBody(req, RequestSchema, 600_000);
    const messages = (body.messages || []).map((message) => ({
      role: message.role,
      content: message.content ?? '',
      name: message.name,
      tool_call_id: message.tool_call_id,
    }));
    const packet = body.continuityPacket
      ? parseContinuityPacketV2(body.continuityPacket)
      : messages.length
        ? compileContinuityPacketFromMessages({
            messages,
            sessionId: body.sessionId,
            turnId: body.turnId || `compression-${Date.now()}`,
            estimatedTokens: body.estimatedTokens,
          })
        : undefined;
    const checkpoint = await coordinateContinuityCheckpoint({
      sessionId: body.sessionId,
      turnId: body.turnId,
      namespace: body.namespace || 'zenos',
      estimatedTokens: body.estimatedTokens,
      checkpointSoftLimitTokens: body.checkpointSoftLimitTokens || 160_000,
      packet,
      messages,
      maxChars: body.maxChars || 8_000,
      inputMaxChars: body.inputMaxChars || 120_000,
      reason: body.reason || 'hermes-compression-boundary',
      forceCheckpoint: body.forceCheckpoint === true,
    });
    return routeSuccessResponse({ ok: true, checkpoint }, secured.context, ROUTE);
  } catch (error) {
    return routeErrorResponse(error, secured.context, ROUTE);
  }
}
