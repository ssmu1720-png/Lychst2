import { Router, type IRouter } from 'express';
import { requireAuth, type AuthenticatedRequest } from './authRouter.ts';
import {
  createSupportTicket,
  getUserPreferences,
  listUserTickets,
  saveUserPreferences,
} from './db.ts';
import type {
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

export function createSupportRouter(): IRouter {
  const router: IRouter = Router();
  router.use(requireAuth);

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
