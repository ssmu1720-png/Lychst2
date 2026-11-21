import { Router, type IRouter } from 'express';
import { requireAdmin, requireAuth, type AuthenticatedRequest } from './authRouter.ts';
import {
  adminUpdateUser,
  createCoupon,
  createCustomBotTemplate,
  deleteCoupon,
  deleteCustomBotTemplate,
  getAdminAppDetails,
  listAllAdminUsers,
  listAllTickets,
  listCoupons,
  listCustomBotTemplates,
  listEmailCampaigns,
  listVerifiedRecipientEmails,
  makeId,
  nowIso,
  recordEmailCampaign,
  toggleCouponActive,
  updateTicketReply,
} from './db.ts';
import { getEmailTransportStatus, sendBrandedNotificationEmail } from './emailService.ts';
import type {
  BotDeployment,
  BotPlatform,
  EmailCampaign,
  RuntimeEnvironment,
  SupportTicketStatus,
} from '../src/types/lyrihost.ts';

export function createAdminRouter(getDeployments: () => BotDeployment[]): IRouter {
  const router: IRouter = Router();
  router.use(requireAuth, requireAdmin);

  router.get('/overview', (_req: AuthenticatedRequest, res) => {
    res.json({
      details: getAdminAppDetails(),
    });
  });

  router.get('/users', (_req: AuthenticatedRequest, res) => {
    res.json({
      users: listAllAdminUsers(),
    });
  });

  router.patch('/users/:id', (req: AuthenticatedRequest, res) => {
    try {
      const body = (req.body ?? {}) as {
        maxDeployments?: number;
        grantCoinsDelta?: number;
        grantReason?: string;
      };

      const updated = adminUpdateUser({
        targetUserId: req.params.id,
        maxDeployments:
          body.maxDeployments !== undefined ? Number(body.maxDeployments) : undefined,
        grantCoinsDelta:
          body.grantCoinsDelta !== undefined ? Number(body.grantCoinsDelta) : undefined,
        grantReason: body.grantReason,
      });
      res.json({ user: updated });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Unable to update operator user.',
      });
    }
  });

  router.get('/deployments', (_req: AuthenticatedRequest, res) => {
    res.json({
      deployments: getDeployments(),
    });
  });

  router.get('/coupons', (_req: AuthenticatedRequest, res) => {
    res.json({
      coupons: listCoupons(),
    });
  });

  router.post('/coupons', async (req: AuthenticatedRequest, res) => {
    try {
      const body = (req.body ?? {}) as {
        code?: string;
        coins?: number;
        maxUses?: number;
        targetEmail?: string;
        expiresInDays?: number;
        sendEmail?: boolean;
      };

      const coupon = createCoupon({
        code: body.code,
        coins: Number(body.coins),
        maxUses: Number(body.maxUses || 1),
        targetEmail: body.targetEmail || null,
        expiresInDays: body.expiresInDays ? Number(body.expiresInDays) : null,
        createdBy: req.authUser!.email,
      });

      let emailResult: { attempted: boolean; ok?: boolean; error?: string } = { attempted: false };
      if (body.sendEmail && coupon.targetEmail) {
        const sendRes = await sendBrandedNotificationEmail({
          toEmail: coupon.targetEmail,
          badge: 'LYRIHOST COUPON GIFT',
          subject: `You received a ${coupon.coins} Coin Lyrihost Coupon`,
          heading: 'Redeem Your Coin Coupon',
          bodyText: `Administrator ${req.authUser!.email} has issued a coupon worth ${coupon.coins} Coins (${coupon.coins} KSH) to your account.\n\nVisit the Coins page in Lyrihost and enter the coupon code below to claim your balance.`,
          highlightBox: {
            label: 'COUPON CODE',
            value: coupon.code,
          },
        });
        emailResult = { attempted: true, ok: sendRes.ok, error: sendRes.error };
      }

      res.status(201).json({ coupon, emailResult });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Unable to create coupon.',
      });
    }
  });

  router.patch('/coupons/:code', (req: AuthenticatedRequest, res) => {
    try {
      const body = (req.body ?? {}) as { isActive?: boolean };
      const coupon = toggleCouponActive(req.params.code, Boolean(body.isActive));
      res.json({ coupon });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Unable to update coupon.',
      });
    }
  });

  router.delete('/coupons/:code', (req: AuthenticatedRequest, res) => {
    deleteCoupon(req.params.code);
    res.json({ deleted: true });
  });

  router.get('/tickets', (_req: AuthenticatedRequest, res) => {
    res.json({
      tickets: listAllTickets(),
    });
  });

  router.patch('/tickets/:id', async (req: AuthenticatedRequest, res) => {
    try {
      const body = (req.body ?? {}) as {
        status?: SupportTicketStatus;
        adminReply?: string;
        notifyByEmail?: boolean;
      };

      const ticket = updateTicketReply({
        ticketId: req.params.id,
        status: body.status,
        adminReply: body.adminReply,
      });

      let emailResult: { attempted: boolean; ok?: boolean; error?: string } = { attempted: false };
      if (body.notifyByEmail && body.adminReply?.trim()) {
        const sendRes = await sendBrandedNotificationEmail({
          toEmail: ticket.userEmail,
          badge: 'LYRIHOST SUPPORT RESPONSE',
          subject: `Re: ${ticket.subject}`,
          heading: 'Response from Lyrihost Admin',
          bodyText: `Admin replied to your support message ("${ticket.subject}"):\n\n${body.adminReply.trim()}\n\nCurrent ticket status: ${ticket.status.toUpperCase()}`,
        });
        emailResult = { attempted: true, ok: sendRes.ok, error: sendRes.error };
      }

      res.json({ ticket, emailResult });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Unable to update support ticket.',
      });
    }
  });

  router.get('/email-status', async (_req: AuthenticatedRequest, res) => {
    const status = await getEmailTransportStatus();
    res.json(status);
  });

  router.post('/email-test', async (req: AuthenticatedRequest, res) => {
    const body = (req.body ?? {}) as { toEmail?: string };
    const targetEmail = (body.toEmail || req.authUser?.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(targetEmail)) {
      res.status(400).json({ error: 'Valid recipient email address is required.' });
      return;
    }
    const status = await getEmailTransportStatus();
    const result = await sendBrandedNotificationEmail({
      toEmail: targetEmail,
      badge: 'LYRIHOST MAIL DIAGNOSTIC',
      subject: 'Lyrihost Mail Delivery Verification',
      heading: 'Transactional Email Delivery Working',
      bodyText: `This test message confirms your Lyrihost mail transport is delivering OTP and notification emails.\n\nActive provider: ${status.activeProvider}`,
    });
    if (!result.ok) {
      res.status(422).json({
        ok: false,
        error: result.error || 'Email test failed.',
        status,
      });
      return;
    }
    res.json({ ok: true, id: result.id, toEmail: targetEmail, status });
  });

  router.get('/emails', (_req: AuthenticatedRequest, res) => {
    res.json({
      campaigns: listEmailCampaigns(),
    });
  });

  router.post('/emails/send', async (req: AuthenticatedRequest, res) => {
    try {
      const body = (req.body ?? {}) as {
        scope?: 'all' | 'promo_opted_in' | 'custom';
        customEmails?: string;
        subject?: string;
        heading?: string;
        message?: string;
        badge?: string;
      };

      const subject = (body.subject || '').trim();
      const message = (body.message || '').trim();
      const heading = (body.heading || subject).trim();
      const badge = (body.badge || 'LYRIHOST ANNOUNCEMENT').trim();

      if (!subject || !message) {
        res.status(400).json({ error: 'Email subject and message body are required.' });
        return;
      }

      let recipients: string[] = [];
      const scope = body.scope || 'promo_opted_in';
      if (scope === 'custom') {
        recipients = (body.customEmails || '')
          .split(/[\s,;]+/)
          .map((e) => e.trim().toLowerCase())
          .filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e));
      } else {
        recipients = listVerifiedRecipientEmails(scope);
      }

      recipients = Array.from(new Set(recipients));
      if (recipients.length === 0) {
        res.status(400).json({
          error: 'No matching recipients found for this email broadcast.',
        });
        return;
      }

      const results: Array<{ email: string; ok: boolean; error?: string }> = [];
      let sentCount = 0;
      let failedCount = 0;

      for (const email of recipients) {
        const sendRes = await sendBrandedNotificationEmail({
          toEmail: email,
          badge,
          subject,
          heading,
          bodyText: message,
        });
        if (sendRes.ok) {
          sentCount += 1;
          results.push({ email, ok: true });
        } else {
          failedCount += 1;
          results.push({ email, ok: false, error: sendRes.error });
        }
      }

      const campaign: EmailCampaign = {
        id: makeId('cmp'),
        senderEmail: req.authUser!.email,
        recipientScope: scope,
        recipientCount: recipients.length,
        subject,
        bodyText: message,
        sentCount,
        failedCount,
        createdAt: nowIso(),
      };
      recordEmailCampaign(campaign);

      res.json({ campaign, results });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to broadcast email campaign.',
      });
    }
  });

  router.get('/templates', (_req: AuthenticatedRequest, res) => {
    res.json({
      templates: listCustomBotTemplates(),
    });
  });

  router.post('/templates', (req: AuthenticatedRequest, res) => {
    try {
      const body = (req.body ?? {}) as {
        name?: string;
        repoInput?: string;
        sessionPairUrl?: string;
        description?: string;
        platform?: BotPlatform;
        framework?: string;
        runtime?: RuntimeEnvironment;
        defaultBranch?: string;
        installCommand?: string;
        buildCommand?: string;
        startCommand?: string;
        imageUrl?: string;
        defaultEnvKeys?: string[] | string;
      };

      const envKeys = Array.isArray(body.defaultEnvKeys)
        ? body.defaultEnvKeys
        : typeof body.defaultEnvKeys === 'string'
          ? body.defaultEnvKeys.split(/[\s,;]+/)
          : undefined;

      const template = createCustomBotTemplate(
        {
          name: body.name || '',
          repoInput: body.repoInput || '',
          sessionPairUrl: body.sessionPairUrl,
          description: body.description || '',
          platform: body.platform,
          framework: body.framework,
          runtime: body.runtime,
          defaultBranch: body.defaultBranch,
          installCommand: body.installCommand,
          buildCommand: body.buildCommand,
          startCommand: body.startCommand,
          imageUrl: body.imageUrl,
          defaultEnvKeys: envKeys,
        },
        req.authUser!.email
      );

      res.status(201).json({ template });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Unable to create custom bot template.',
      });
    }
  });

  router.delete('/templates/:id', (req: AuthenticatedRequest, res) => {
    const deleted = deleteCustomBotTemplate(req.params.id);
    if (!deleted) {
      res.status(404).json({ error: 'Custom bot template not found.' });
      return;
    }
    res.json({ deleted: true });
  });

  return router;
}
