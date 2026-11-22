import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import {
  ADMIN_EMAIL,
  SUPPORT_PHONE,
  type BotDeployment,
} from '../src/types/lyrihost.ts';

export interface SupportChatTurn {
  role: 'user' | 'assistant';
  text: string;
}

export interface SupportAssistRequest {
  message: string;
  history?: SupportChatTurn[];
  userEmail: string;
  deployments?: BotDeployment[];
}

export interface SupportAssistResult {
  reply: string;
  escalateRecommended: boolean;
  whatsappNumber: string;
  supportEmail: string;
}

const SUPPORT_MODEL = 'gemini-4-hydrogen';

function createGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    const err = new Error(
      'AI Support Assistant is not configured yet (missing GEMINI_API_KEY on server).'
    ) as Error & { statusCode?: number };
    err.statusCode = 503;
    throw err;
  }

  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function buildSafeFleetSummary(deployments: BotDeployment[]): string {
  if (!deployments.length) {
    return 'Operator currently has 0 deployed bots.';
  }

  return deployments
    .slice(0, 8)
    .map((dep) => {
      const recentLogs = (dep.logs || [])
        .slice(-3)
        .map((l) => `[${l.stage}] ${l.message.slice(0, 140)}`)
        .join(' | ');
      const envKeys = (dep.settings?.envVars || []).map((v) => v.key).slice(0, 12).join(', ');
      return [
        `- Bot "${dep.name}" (${dep.platform}/${dep.framework})`,
        `status=${dep.status}`,
        `uptime=${dep.uptimeSeconds}s`,
        `latency=${dep.gatewayLatencyMs}ms`,
        `restartPolicy=${dep.settings?.restartPolicy || 'always'}`,
        `ram=${dep.memoryMb}/${dep.memoryLimitMb}MB`,
        envKeys ? `configuredVarKeys=[${envKeys}]` : '',
        recentLogs ? `recentLogs="${recentLogs}"` : '',
      ]
        .filter(Boolean)
        .join(', ');
    })
    .join('\n');
}

function shouldRecommendEscalation(userMessage: string, replyText: string): boolean {
  const combined = `${userMessage}\n${replyText}`.toLowerCase();
  return (
    combined.includes(SUPPORT_PHONE) ||
    combined.includes(ADMIN_EMAIL.toLowerCase()) ||
    /\b(mpesa|m-pesa|payment|stk|refund|billing|coin balance|suspend|banned|still not working|tried everything|hard|urgent|escalat|human support|admin ticket|contact support|401|403)\b/i.test(
      combined
    )
  );
}

export async function generateSupportAssistance(
  input: SupportAssistRequest
): Promise<SupportAssistResult> {
  const ai = createGeminiClient();
  const fleetSummary = buildSafeFleetSummary(input.deployments || []);

  const systemInstruction = [
    'You are the Lyrihost Technical Support AI Assistant inside the operator dashboard.',
    'Help operators quickly diagnose and fix issues with WhatsApp MD bots, Discord/Telegram/Slack bots, GitHub repo scanning, session pairing, environment variables, hosting plans, and deployment errors.',
    '',
    'Key Lyrihost platform facts:',
    '- WhatsApp MD bots (e.g., Sila-MD, TurboFex, Toxic-MD, KING-MD, ELITE-PRO-V1, Vanguard-MD) need a fresh SESSION_ID from the template pairing site, MODE=public (if they want others to test commands), PREFIX (e.g. .), and OWNER_NUMBER.',
    '- Error 401 / 403 / "rejected session" means the WhatsApp Linked Device session expired or was logged out — regenerate SESSION_ID on the pairing site, update Config Vars, and Redeploy.',
    '- Always set Restart Policy to "always" for 24/7 uptime. Lyrihost runs active 15s WebSocket keepalives, group metadata caching, and local/public anti-sleep probes.',
    '- Private GitHub repos require a GitHub Personal Access Token (PAT) in Settings or deployment scan.',
    '- Wallet & Hosting Plans use Coins (1 Coin = 1 KSH): 15-Day Standard (10 Coins / 512MB), 30-Day Pro (25 Coins / 1024MB), Unlimited Cluster (50 Coins / 2048MB). M-Pesa STK Push, Daily Streak, Referrals, and Coupons are in the Coins tab.',
    '',
    'Escalation rule for hard/unresolved issues:',
    `- If the problem is hard, requires manual intervention, billing/M-Pesa verification, account recovery, or persists after troubleshooting steps, tell the user clearly to reach Human Support directly:`,
    `  * Support Phone / WhatsApp: ${SUPPORT_PHONE} (https://wa.me/${SUPPORT_PHONE})`,
    `  * Support Email: ${ADMIN_EMAIL}`,
    `  * Or use the "Write to Admin" ticket form on this Support page.`,
    '',
    'Response style:',
    '- Concise, direct, practical numbered steps (typically under 180 words). Do not invent features or guess secret values.',
    `- Operator email: ${input.userEmail}`,
    `- Operator fleet snapshot (safe metadata only):\n${fleetSummary}`,
  ].join('\n');

  const trimmedHistory = (input.history || [])
    .slice(-8)
    .filter((h) => h.text && h.text.trim())
    .map((h) => ({
      role: h.role === 'assistant' ? ('model' as const) : ('user' as const),
      parts: [{ text: h.text.trim().slice(0, 1500) }],
    }));

  const contents = [
    ...trimmedHistory,
    {
      role: 'user' as const,
      parts: [{ text: input.message.trim().slice(0, 2000) }],
    },
  ];

  const response = await ai.models.generateContent({
    model: SUPPORT_MODEL,
    contents,
    config: {
      systemInstruction,
      thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
    },
  });

  const reply = (response.text || '').trim();
  if (!reply) {
    throw new Error('AI support returned an empty response. Please try again or contact human support.');
  }

  return {
    reply,
    escalateRecommended: shouldRecommendEscalation(input.message, reply),
    whatsappNumber: SUPPORT_PHONE,
    supportEmail: ADMIN_EMAIL,
  };
}
