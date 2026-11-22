import { Router, type IRouter } from 'express';
import { requireAuth, type AuthenticatedRequest } from './authRouter.ts';
import {
  generateSupportAssistance,
  type SupportChatTurn,
} from './aiSupportService.ts';
import {
  createSupportTicket,
  getUserPreferences,
  listUserTickets,
  saveUserPreferences,
} from './db.ts';
import type {
  BotDeployment,
  PlatformPreferences,
  SupportTicketCategory,
  SupportTicketPriority,
} from '../src/types/lyrihost.ts';

const VALID_CATEGORIES = new Set<SupportTicketCategory>([
  'complaint',
  'billing',
  'bug',
  'feature',
  'other',
]);
const VALID_PRIORITIES = new Set<SupportTicketPriority>(['normal', 'high', 'urgent']);

export function createSupportRouter(
  getUserDeployments?: (userId: string) => BotDeployment[]
): IRouter {
  const router: IRouter = Router();
  router.use(requireAuth);

  router.post('/ai-assist', async (req: AuthenticatedRequest, res) => {
    const body = (req.body ?? {}) as {
      message?: string;
      history?: SupportChatTurn[];
    };

    const userMessage = typeof body.message === 'string' ? body.message.trim() : '';
    if (userMessage.length < 2) {
      res.status(400).json({ error: 'Please describe your issue so AI Support can assist you.' });
      return;
    }

    const sanitizedHistory: SupportChatTurn[] = Array.isArray(body.history)
      ? body.history
          .filter(
            (item): item is SupportChatTurn =>
              Boolean(item) &&
              (item.role === 'user' || item.role === 'assistant') &&
              typeof item.text === 'string'
          )
          .slice(-8)
      : [];

    try {
      const deployments = getUserDeployments ? getUserDeployments(req.authUser!.id) : [];
      const result = await generateSupportAssistance({
        message: userMessage,
        history: sanitizedHistory,
        userEmail: req.authUser!.email,
        deployments,
      });
      res.json(result);
    } catch (err) {
      const typedErr = err as Error & { statusCode?: number; status?: number };
      const status =
        typeof typedErr.statusCode === 'number'
          ? typedErr.statusCode
          : typeof typedErr.status === 'number' && typedErr.status >= 400 && typedErr.status < 600
            ? typedErr.status
            : 502;
      res.status(status).json({
        error: typedErr.message || 'Unable to reach AI Support Assistant right now.',
      });
    }
  });

  router.get('/tickets', (req: AuthenticatedRequest, res) => {
    res.json({
      tickets: listUserTickets(req.authUser!.id),
    });
  });

  router.post('/tickets', (req: AuthenticatedRequest, res) => {
    const body = (req.body ?? {}) as {
      category?: string;
      priority?: string;
      subject?: string;
      message?: string;
    };

    const subject = (body.subject || '').trim();
    const message = (body.message || '').trim();
    if (subject.length < 3) {
      res.status(400).json({ error: 'Please provide a clear subject (at least 3 characters).' });
      return;
    }
    if (message.length < 8) {
      res.status(400).json({ error: 'Please describe your message or complaint (at least 8 characters).' });
      return;
    }

    const category = VALID_CATEGORIES.has(body.category as SupportTicketCategory)
      ? (body.category as SupportTicketCategory)
      : 'complaint';
    const priority = VALID_PRIORITIES.has(body.priority as SupportTicketPriority)
      ? (body.priority as SupportTicketPriority)
      : 'normal';

    const ticket = createSupportTicket({
      userId: req.authUser!.id,
      userEmail: req.authUser!.email,
      category,
      priority,
      subject,
      message,
    });

    res.status(201).json({ ticket });
  });

  router.get('/preferences', (req: AuthenticatedRequest, res) => {
    res.json(getUserPreferences(req.authUser!.id));
  });

  router.patch('/preferences', (req: AuthenticatedRequest, res) => {
    const body = (req.body ?? {}) as Partial<PlatformPreferences>;
    const updated = saveUserPreferences(req.authUser!.id, body);
    res.json(updated);
  });

  return router;
}
