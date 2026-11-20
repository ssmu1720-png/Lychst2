import { Router, type IRouter } from 'express';
import { requireAuth, type AuthenticatedRequest } from './authRouter.ts';
import {
  buildAuthUser,
  claimDailyStreak,
  completeMpesaStkRequest,
  createMpesaStkRequest,
  failMpesaStkRequest,
  getMpesaStkRequestByCheckoutId,
  getMpesaStkRequestById,
  getUserById,
  listUserMpesaRequests,
  listUserPurchases,
  listUserReferrals,
  listUserTransactions,
  makeId,
  redeemCoupon,
  transferCoins,
  updateMpesaStkDispatch,
} from './db.ts';
import { sendBrandedNotificationEmail } from './emailService.ts';
import {
  getMpesaGatewayInfo,
  initiateMpesaStkPush,
  normalizeKenyanPhone,
  queryRemoteMpesaStatus,
  verifyMpesaCallbackSecret,
} from './mpesaService.ts';
import { DEPLOYMENT_PLANS } from '../src/types/lyrihost.ts';

function extractStkCallbackFields(rawBody: Record<string, unknown>): {
  lookupId: string;
  confirmed: boolean;
  failed: boolean;
  mpesaReceipt: string | null;
  resultDesc: string;
} {
  // 1. Standard Safaricom Daraja STK Callback shape: Body.stkCallback
  const bodyObj = (rawBody.Body as Record<string, unknown> | undefined)?.stkCallback as
    | Record<string, unknown>
    | undefined;
  if (bodyObj && typeof bodyObj === 'object') {
    const checkoutId = String(bodyObj.CheckoutRequestID || bodyObj.MerchantRequestID || '').trim();
    const resultCode = Number(bodyObj.ResultCode);
    const resultDesc = String(bodyObj.ResultDesc || '').trim();
    let mpesaReceipt: string | null = null;
    const items = (bodyObj.CallbackMetadata as Record<string, unknown> | undefined)?.Item;
    if (Array.isArray(items)) {
      for (const item of items) {
        if (
          item &&
          typeof item === 'object' &&
          (item as { Name?: string }).Name === 'MpesaReceiptNumber'
        ) {
          mpesaReceipt = String((item as { Value?: unknown }).Value || '').trim() || null;
        }
      }
    }
    return {
      lookupId: checkoutId,
      confirmed: resultCode === 0 && Boolean(mpesaReceipt),
      failed: Number.isFinite(resultCode) && resultCode !== 0,
      mpesaReceipt,
      resultDesc: resultDesc || (resultCode === 0 ? 'Payment confirmed' : 'Payment not completed'),
    };
  }

  // 2. Flat / CourtneyTech Gateway webhook shape (supports snake_case, camelCase, or nested data)
  const nestedData =
    rawBody.data && typeof rawBody.data === 'object'
      ? ({ ...rawBody, ...(rawBody.data as Record<string, unknown>) } as Record<string, unknown>)
      : rawBody;

  const lookupId = String(
    nestedData.checkout_request_id ||
      nestedData.CheckoutRequestID ||
      nestedData.checkoutRequestId ||
      nestedData.requestId ||
      nestedData.reference ||
      nestedData.accountReference ||
      nestedData.account_reference ||
      ''
  ).trim();

  const statusStr = String(nestedData.status || nestedData.state || '').trim().toLowerCase();
  const hasResultCode =
    nestedData.ResultCode !== undefined ||
    nestedData.resultCode !== undefined ||
    nestedData.result_code !== undefined;
  const resultCodeNum = hasResultCode
    ? Number(nestedData.ResultCode ?? nestedData.resultCode ?? nestedData.result_code)
    : NaN;
  const mpesaReceipt =
    String(
      nestedData.mpesaReceipt ||
        nestedData.MpesaReceiptNumber ||
        nestedData.mpesa_receipt_number ||
        nestedData.receipt ||
        nestedData.transactionCode ||
        nestedData.transaction_code ||
        ''
    ).trim() || null;
  const resultDesc = String(
    nestedData.ResultDesc ||
      nestedData.resultDesc ||
      nestedData.result_desc ||
      nestedData.message ||
      nestedData.reason ||
      ''
  ).trim();

  const confirmed =
    Boolean(mpesaReceipt) &&
    (resultCodeNum === 0 ||
      statusStr === 'completed' ||
      statusStr === 'success' ||
      statusStr === 'paid' ||
      statusStr === 'confirmed');

  const failed =
    (hasResultCode && Number.isFinite(resultCodeNum) && resultCodeNum !== 0) ||
    statusStr === 'failed' ||
    statusStr === 'cancelled' ||
    statusStr === 'rejected';

  return {
    lookupId,
    confirmed,
    failed,
    mpesaReceipt,
    resultDesc: resultDesc || (confirmed ? 'Payment confirmed' : 'Payment failed or cancelled'),
  };
}

export function createWalletRouter(): IRouter {
  const router: IRouter = Router();

  // Public M-Pesa / CourtneyTech STK webhook callback
  // Verifies API secret header OR confirms status directly via CourtneyTech /v2/status server-to-server
  router.post('/mpesa/callback', async (req, res) => {
    const rawBody = (req.body ?? {}) as Record<string, unknown>;
    const hasValidSecret = verifyMpesaCallbackSecret(req.headers, rawBody);
    const parsed = extractStkCallbackFields(rawBody);

    if (!parsed.lookupId) {
      if (!hasValidSecret) {
        res.status(401).json({
          error: 'Unauthorized M-Pesa callback signature or API secret.',
        });
        return;
      }
      res.status(400).json({ error: 'Missing requestId or CheckoutRequestID in callback payload.' });
      return;
    }

    try {
      let confirmed = parsed.confirmed;
      let failed = parsed.failed;
      let receiptToCredit = parsed.mpesaReceipt;
      let resultDesc = parsed.resultDesc;

      if (!hasValidSecret) {
        const existing =
          getMpesaStkRequestById(parsed.lookupId) || getMpesaStkRequestByCheckoutId(parsed.lookupId);
        if (!existing || !existing.gatewayDispatched || !existing.checkoutRequestId) {
          res.status(401).json({
            error: 'Unauthorized M-Pesa callback signature or API secret.',
          });
          return;
        }
        const remote = await queryRemoteMpesaStatus(existing.checkoutRequestId);
        if (!remote.checked) {
          res.status(401).json({
            error: 'Unauthorized M-Pesa callback and unable to verify status with CourtneyTech.',
          });
          return;
        }
        confirmed = Boolean(remote.confirmed && remote.mpesaReceipt);
        failed = Boolean(remote.failed);
        receiptToCredit = remote.mpesaReceipt || null;
        resultDesc = remote.resultDesc || parsed.resultDesc;
      }

      if (confirmed && receiptToCredit) {
        const result = completeMpesaStkRequest({
          idOrCheckoutId: parsed.lookupId,
          mpesaReceipt: receiptToCredit,
          resultDesc,
        });

        if (result.newlyCredited) {
          void sendBrandedNotificationEmail({
            toEmail: result.request.email,
            badge: 'LYRIHOST M-PESA RECEIPT',
            subject: `M-Pesa Confirmed: +${result.request.coins} Coins Credited`,
            heading: 'M-Pesa Payment Confirmed',
            bodyText: `Your M-Pesa STK payment of ${result.request.amountKsh} KSH from ${result.request.phoneNumber} has been confirmed.\n\nM-Pesa Receipt: ${receiptToCredit}`,
            highlightBox: {
              label: 'CREDITED AFTER CONFIRMATION',
              value: `+${result.request.coins} COINS`,
            },
          }).catch(() => {});
        }

        res.json({
          ok: true,
          settled: true,
          newlyCredited: result.newlyCredited,
          request: result.request,
        });
        return;
      }

      if (failed) {
        const failedReq = failMpesaStkRequest(parsed.lookupId, resultDesc);
        res.json({ ok: true, settled: false, failed: true, request: failedReq });
        return;
      }

      res.status(400).json({
        error:
          'Callback did not contain both confirmed payment status and M-Pesa receipt number. 0 Coins credited.',
      });
    } catch (err) {
      res.status(404).json({
        error: err instanceof Error ? err.message : 'Unable to process M-Pesa callback.',
      });
    }
  });

  // All interactive wallet routes require an authenticated session
  router.use(requireAuth);

  router.get('/summary', async (req: AuthenticatedRequest, res) => {
    const existingUser = getUserById(req.authUser!.id);
    if (!existingUser) {
      res.status(404).json({ error: 'Account not found.' });
      return;
    }

    // Reconcile recent pending & dispatched M-Pesa STK requests directly with CourtneyTech /v2/status
    const pendingToCheck = listUserMpesaRequests(existingUser.id, 10)
      .filter((r) => r.status === 'pending' && r.gatewayDispatched && r.checkoutRequestId)
      .slice(0, 2);

    for (const item of pendingToCheck) {
      try {
        const remote = await queryRemoteMpesaStatus(item.checkoutRequestId!);
        if (remote.checked && remote.confirmed && remote.mpesaReceipt) {
          completeMpesaStkRequest({
            idOrCheckoutId: item.id,
            mpesaReceipt: remote.mpesaReceipt,
            resultDesc: remote.resultDesc,
          });
        } else if (remote.checked && remote.failed) {
          failMpesaStkRequest(item.id, remote.resultDesc || 'Payment failed or cancelled on phone.');
        }
      } catch {
        // Ignore transient status lookup errors; request remains safely pending at 0 coins
      }
    }

    const freshUser = getUserById(existingUser.id) || existingUser;
    res.json({
      user: buildAuthUser(freshUser),
      plans: DEPLOYMENT_PLANS,
      transactions: listUserTransactions(freshUser.id, 60),
      purchases: listUserPurchases(freshUser.id, 25),
      mpesaRequests: listUserMpesaRequests(freshUser.id, 25),
      mpesaGateway: getMpesaGatewayInfo(),
      referrals: listUserReferrals(freshUser.id),
    });
  });

  router.post('/streak/claim', (req: AuthenticatedRequest, res) => {
    try {
      const { user, reward } = claimDailyStreak(req.authUser!.id);
      res.json({
        user: buildAuthUser(user),
        reward,
      });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Unable to claim daily streak reward.',
      });
    }
  });

  // Strictly block unverified instant/self-credit purchases so NO free coins can ever be allocated
  router.post('/purchase', (_req: AuthenticatedRequest, res) => {
    res.status(403).json({
      error:
        'Unverified instant coin top-ups are disabled. Coins can ONLY be allocated after confirmed M-Pesa STK Push payment (/api/wallet/mpesa/stk-push).',
    });
  });

  router.post('/mpesa/stk-push', async (req: AuthenticatedRequest, res) => {
    try {
      const body = (req.body ?? {}) as {
        phoneNumber?: string;
        coins?: number;
      };

      const normalizedPhone = normalizeKenyanPhone(body.phoneNumber || '');
      const coins = Math.floor(Number(body.coins));
      if (!Number.isInteger(coins) || coins < 1 || coins > 500000) {
        res.status(400).json({
          error: 'Enter a valid coin amount between 1 and 500,000 Coins (1 Coin = 1 KSH).',
        });
        return;
      }

      const requestId = makeId('mp');
      // Creates PENDING record with 0 coins allocated!
      createMpesaStkRequest({
        id: requestId,
        userId: req.authUser!.id,
        email: req.authUser!.email,
        phoneNumber: normalizedPhone,
        coins,
      });

      const host = req.get('host') || 'localhost:3000';
      const protocol =
        (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim() ||
        req.protocol ||
        'https';
      const callbackUrl = `${protocol}://${host}/api/wallet/mpesa/callback`;

      const dispatch = await initiateMpesaStkPush({
        requestId,
        phoneNumber: normalizedPhone,
        amountKsh: coins,
        coins,
        email: req.authUser!.email,
        callbackUrl,
      });

      const updatedRequest = updateMpesaStkDispatch({
        id: requestId,
        checkoutRequestId: dispatch.checkoutRequestId,
        merchantRequestId: dispatch.merchantRequestId,
        gatewayDispatched: dispatch.dispatched,
        gatewayMessage: dispatch.customerMessage,
        markFailed: dispatch.gatewayConfigured && !dispatch.dispatched,
      });

      const freshUser = getUserById(req.authUser!.id)!;

      res.status(201).json({
        ok: true,
        request: updatedRequest,
        dispatch,
        mpesaGateway: getMpesaGatewayInfo(),
        user: buildAuthUser(freshUser),
      });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Unable to initiate M-Pesa STK Push.',
      });
    }
  });

  router.get('/mpesa/status/:id', async (req: AuthenticatedRequest, res) => {
    const existing =
      getMpesaStkRequestById(req.params.id) || getMpesaStkRequestByCheckoutId(req.params.id);
    if (!existing) {
      res.status(404).json({ error: 'M-Pesa STK request not found.' });
      return;
    }
    if (existing.userId !== req.authUser!.id && !req.authUser!.role.includes('admin')) {
      res.status(403).json({ error: 'Access denied to this M-Pesa payment record.' });
      return;
    }

    let current = existing;
    if (current.status === 'pending' && current.gatewayDispatched && current.checkoutRequestId) {
      const remote = await queryRemoteMpesaStatus(current.checkoutRequestId);
      if (remote.checked && remote.confirmed && remote.mpesaReceipt) {
        const settled = completeMpesaStkRequest({
          idOrCheckoutId: current.id,
          mpesaReceipt: remote.mpesaReceipt,
          resultDesc: remote.resultDesc,
        });
        current = settled.request;
      } else if (remote.checked && remote.failed) {
        current = failMpesaStkRequest(
          current.id,
          remote.resultDesc || 'Payment failed or cancelled on phone.'
        );
      }
    }

    const freshUser = getUserById(req.authUser!.id)!;
    res.json({
      request: current,
      user: buildAuthUser(freshUser),
    });
  });

  router.post('/transfer', (req: AuthenticatedRequest, res) => {
    try {
      const body = (req.body ?? {}) as {
        recipientEmail?: string;
        amount?: number;
        note?: string;
      };
      if (!body.recipientEmail || !body.recipientEmail.trim()) {
        res.status(400).json({ error: 'Recipient email address is required.' });
        return;
      }

      const result = transferCoins({
        fromUserId: req.authUser!.id,
        toEmail: body.recipientEmail,
        amount: Number(body.amount),
        note: body.note,
      });

      const updatedUser = getUserById(req.authUser!.id)!;
      res.json({
        user: buildAuthUser(updatedUser),
        transfer: result,
        message: `Successfully sent ${result.amount} Coin${result.amount === 1 ? '' : 's'} to ${result.recipientEmail}.`,
      });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Coin transfer failed.',
      });
    }
  });

  router.post('/coupons/redeem', (req: AuthenticatedRequest, res) => {
    try {
      const body = (req.body ?? {}) as { code?: string };
      const redemption = redeemCoupon(req.authUser!.id, body.code || '');
      const updatedUser = getUserById(req.authUser!.id)!;
      res.json({
        user: buildAuthUser(updatedUser),
        redemption,
        message: `Coupon "${redemption.code}" redeemed for +${redemption.coinsAwarded} Coins!`,
      });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Unable to redeem coupon.',
      });
    }
  });

  return router;
}
