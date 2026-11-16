// HTTP endpoints the meeting worker calls. They share the web server with the Teams endpoint,
// so every route checks a bearer token: the shared secret to claim a meeting, then a token that
// is only valid for that one meeting.

import express, { type NextFunction, type Request, type Response } from 'express';
import { meetingToken, safeEqual } from '../core/ids.js';
import { errorMessage, logger } from '../core/log.js';
import type { AnswerLine, WorkerEvent } from '../core/types.js';
import type { ControlService } from './service.js';

const log = logger('internal-api');

interface Mountable {
  get: express.Application['get'];
  post: express.Application['post'];
  use: express.Application['use'];
}

function bearer(req: Request): string {
  const header = req.headers.authorization ?? '';
  return header.startsWith('Bearer ') ? header.slice(7) : '';
}

export function mountInternalApi(app: Mountable, service: ControlService, sharedSecret: string): void {
  if (sharedSecret.length < 24) throw new Error('WORKER_SHARED_SECRET must be at least 24 characters');
  const json = express.json({ limit: '4mb' });

  const requireShared = (req: Request, res: Response, next: NextFunction) => {
    if (!safeEqual(bearer(req), sharedSecret)) {
      res.status(401).json({ error: 'unauthorised' });
      return;
    }
    next();
  };
  const requireMeeting = (req: Request, res: Response, next: NextFunction) => {
    const id = String(req.params.id ?? '');
    if (!id || !safeEqual(bearer(req), meetingToken(sharedSecret, id))) {
      res.status(401).json({ error: 'unauthorised' });
      return;
    }
    next();
  };
  const guard = (handler: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response) => {
    handler(req, res).catch((err) => {
      log.error('Request failed', { path: req.path, error: errorMessage(err) });
      if (!res.headersSent) res.status(500).json({ error: 'internal error' });
      else res.end();
    });
  };

  app.get('/healthz', (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  app.post(
    '/internal/claim',
    requireShared,
    guard(async (req, res) => {
      const assignment = await service.claim({ standby: req.headers['x-worker-standby'] === '1' });
      if (!assignment) {
        res.status(204).end();
        return;
      }
      res.json(assignment);
    }),
  );

  // The receiver worker: a calling token for the assistant's Teams account.
  app.post(
    '/internal/teams/token',
    requireShared,
    guard(async (_req, res) => {
      const token = await service.teamsToken();
      if (!token) {
        res.status(503).json({ error: 'assistant account not connected' });
        return;
      }
      res.json({ token: token.token, expiresOn: token.expiresOn, userId: token.userId });
    }),
  );

  // The receiver worker: someone is calling the assistant, or adding it to a call. Take it or not?
  app.post(
    '/internal/teams/incoming',
    requireShared,
    json,
    guard(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const decision = await service.acceptIncomingCall({
        ...(typeof body.callerAadId === 'string' ? { callerAadId: body.callerAadId } : {}),
        callerName: typeof body.callerName === 'string' ? body.callerName.slice(0, 200) : 'Someone',
        groupCall: body.groupCall === true,
        ...(typeof body.threadId === 'string' ? { threadId: body.threadId.slice(0, 300) } : {}),
      });
      if ('reject' in decision) {
        res.status(403).json({ error: decision.reject });
        return;
      }
      res.json(decision.assignment);
    }),
  );

  app.post(
    '/internal/meetings/:id/events',
    requireMeeting,
    json,
    guard(async (req, res) => {
      const events = Array.isArray(req.body?.events) ? (req.body.events as WorkerEvent[]) : [];
      res.json(await service.onWorkerEvents(String(req.params.id), events));
    }),
  );

  app.post(
    '/internal/meetings/:id/speak',
    requireMeeting,
    json,
    guard(async (req, res) => {
      const text = typeof req.body?.text === 'string' ? req.body.text.slice(0, 1000) : '';
      if (!text) {
        res.status(400).json({ error: 'text is required' });
        return;
      }
      res.json(await service.speak(String(req.params.id), text));
    }),
  );

  // Streams the answer as newline delimited JSON, one line per spoken sentence.
  app.post(
    '/internal/meetings/:id/ask',
    requireMeeting,
    json,
    guard(async (req, res) => {
      const question = typeof req.body?.question === 'string' ? req.body.question.slice(0, 2000) : '';
      const speakerName = typeof req.body?.speakerName === 'string' ? req.body.speakerName.slice(0, 200) : 'Someone';
      const speakerAadId = typeof req.body?.speakerAadId === 'string' ? req.body.speakerAadId : undefined;
      if (!question) {
        res.status(400).json({ error: 'question is required' });
        return;
      }
      const abort = new AbortController();
      res.on('close', () => {
        if (!res.writableEnded) abort.abort();
      });
      res.status(200);
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();
      const write = (line: AnswerLine) => {
        if (!res.writableEnded && !abort.signal.aborted) res.write(`${JSON.stringify(line)}\n`);
      };
      await service.answerVoice(String(req.params.id), { speakerAadId, speakerName, question }, write, abort.signal);
      res.end();
    }),
  );
}
