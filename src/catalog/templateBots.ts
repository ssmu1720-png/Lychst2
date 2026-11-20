import type { BotPlatform, RuntimeEnvironment } from '../types/lyrihost.ts';

export interface TemplateEnvField {
  key: string;
  label: string;
  placeholder: string;
  isSecret: boolean;
}

export interface TemplateBotSpec {
  id: string;
  name: string;
  repoFullName: string;
  repoUrl: string;
  sessionPairUrl: string;
  sessionPairHost: string;
  description: string;
  imageUrl: string;
  imageAlt: string;
  platform: BotPlatform;
  framework: string;
  runtime: RuntimeEnvironment;
  defaultBranch: string;
  installCommand: string;
  buildCommand: string;
  startCommand: string;
  defaultEnvVars: TemplateEnvField[];
}

export const TEMPLATE_BOTS: TemplateBotSpec[] = [
  {
    id: 'keith',
    name: 'Keith',
    repoFullName: 'keithghost/KEITH-MD',
    repoUrl: 'https://github.com/keithghost/KEITH-MD',
    sessionPairUrl: 'https://keith-pair.onrender.com',
    sessionPairHost: 'keith-pair.onrender.com',
    description:
      'High-speed WhatsApp Multi-Device bot featuring automated media tools, group moderation, anti-delete recovery, and lightweight Baileys session handling.',
    imageUrl: '/src/assets/images/bot_keith_1795010401552.jpg',
    imageAlt: 'Keith WhatsApp bot cyberpunk commander emblem',
    platform: 'whatsapp',
    framework: 'Baileys MD',
    runtime: 'node-20',
    defaultBranch: 'main',
    installCommand: 'npm install --legacy-peer-deps --ignore-engines',
    buildCommand: '',
    startCommand: 'npm start',
    defaultEnvVars: [
      { key: 'SESSION_ID', label: 'Session ID', placeholder: 'KEITH;;;...', isSecret: true },
      { key: 'PREFIX', label: 'Command Prefix', placeholder: '.', isSecret: false },
      { key: 'OWNER_NUMBER', label: 'Owner Number', placeholder: '2547...', isSecret: false },
    ],
  },
  {
    id: 'ultra-guru',
    name: 'ULTRA-GURU',
    repoFullName: 'Guru322/GURU-Ai',
    repoUrl: 'https://github.com/Guru322/GURU-Ai',
    sessionPairUrl: 'https://guru-pair.onrender.com',
    sessionPairHost: 'guru-pair.onrender.com',
    description:
      'Full-featured modular WhatsApp MD assistant with rich plugin support, sticker studio, AI command pipelines, and low-latency message dispatch.',
    imageUrl: '/src/assets/images/bot_ultra_guru_1795010403502.jpg',
    imageAlt: 'ULTRA-GURU bot cosmic digital sage artwork',
    platform: 'whatsapp',
    framework: 'Baileys MD',
    runtime: 'node-20',
    defaultBranch: 'main',
    installCommand: 'npm install --legacy-peer-deps --ignore-engines',
    buildCommand: '',
    startCommand: 'npm start',
    defaultEnvVars: [
      { key: 'SESSION_ID', label: 'Session ID', placeholder: 'GURU~...', isSecret: true },
      { key: 'PREFIX', label: 'Command Prefix', placeholder: '.', isSecret: false },
      { key: 'OWNER_NUMBER', label: 'Owner Number', placeholder: '91...', isSecret: false },
    ],
  },
  {
    id: 'black-panther',
    name: 'BLACK-PANTHER',
    repoFullName: 'koyoteh/BLACK-PANTHER',
    repoUrl: 'https://github.com/koyoteh/BLACK-PANTHER',
    sessionPairUrl: 'https://panther-pair.onrender.com',
    sessionPairHost: 'panther-pair.onrender.com',
    description:
      'Stealth-themed WhatsApp automation suite engineered for responsive group protection, anti-link enforcement, and multi-session stability.',
    imageUrl: '/src/assets/images/bot_black_panther_1795010403082.jpg',
    imageAlt: 'BLACK-PANTHER obsidian neon panther artwork',
    platform: 'whatsapp',
    framework: 'Baileys MD',
    runtime: 'node-20',
    defaultBranch: 'main',
    installCommand: 'npm install --legacy-peer-deps --ignore-engines',
    buildCommand: '',
    startCommand: 'npm start',
    defaultEnvVars: [
      { key: 'SESSION_ID', label: 'Session ID', placeholder: 'PANTHER~...', isSecret: true },
      { key: 'PREFIX', label: 'Command Prefix', placeholder: '.', isSecret: false },
      { key: 'OWNER_NUMBER', label: 'Owner Number', placeholder: '234...', isSecret: false },
    ],
  },
  {
    id: 'dave-x-ultra',
    name: 'DAVE-X-ULTRA',
    repoFullName: 'Davex-254/DAVE-X-ULTRA',
    repoUrl: 'https://github.com/Davex-254/DAVE-X-ULTRA',
    sessionPairUrl: 'https://dave-pair.onrender.com',
    sessionPairHost: 'dave-pair.onrender.com',
    description:
      'High-throughput utility and entertainment WhatsApp bot featuring fast downloaders, status savers, and automated session keepalive.',
    imageUrl: '/src/assets/images/bot_dave_x_ultra_1795010402588.jpg',
    imageAlt: 'DAVE-X-ULTRA robotic sentinel emblem',
    platform: 'whatsapp',
    framework: 'Baileys MD',
    runtime: 'node-20',
    defaultBranch: 'main',
    installCommand: 'npm install --legacy-peer-deps --ignore-engines',
    buildCommand: '',
    startCommand: 'npm start',
    defaultEnvVars: [
      { key: 'SESSION_ID', label: 'Session ID', placeholder: 'DAVE~...', isSecret: true },
      { key: 'PREFIX', label: 'Command Prefix', placeholder: '.', isSecret: false },
      { key: 'OWNER_NUMBER', label: 'Owner Number', placeholder: '2547...', isSecret: false },
    ],
  },
  {
    id: 'fee-xmd',
    name: 'Fee-xmd',
    repoFullName: 'Fred1e/FEE-XMD',
    repoUrl: 'https://github.com/Fred1e/FEE-XMD',
    sessionPairUrl: 'https://fee-pair.onrender.com',
    sessionPairHost: 'fee-pair.onrender.com',
    description:
      'Cleanly structured WhatsApp XMD framework tuned for fast command execution, auto-status interactions, and streamlined cloud hosting.',
    imageUrl: '/src/assets/images/bot_fee_xmd_1795010403374.jpg',
    imageAlt: 'Fee-xmd crimson cyber circuit artwork',
    platform: 'whatsapp',
    framework: 'Baileys XMD',
    runtime: 'node-22',
    defaultBranch: 'main',
    installCommand: 'npm install --legacy-peer-deps --ignore-engines',
    buildCommand: '',
    startCommand: 'npm start',
    defaultEnvVars: [
      { key: 'SESSION_ID', label: 'Session ID', placeholder: 'FEE~...', isSecret: true },
      { key: 'PREFIX', label: 'Command Prefix', placeholder: '.', isSecret: false },
      { key: 'OWNER_NUMBER', label: 'Owner Number', placeholder: '255...', isSecret: false },
    ],
  },
  {
    id: 'silentwolf',
    name: 'silentwolf',
    repoFullName: 'ren-offc/silentwolf-bot',
    repoUrl: 'https://github.com/ren-offc/silentwolf-bot',
    sessionPairUrl: 'https://wolf-pair.onrender.com',
    sessionPairHost: 'wolf-pair.onrender.com',
    description:
      'Apex wolf-themed WhatsApp Multi-Device bot built with resilient socket reconnects, clean command routing, and low memory footprint.',
    imageUrl: '/src/assets/images/bot_silentwolf_1795010404114.jpg',
    imageAlt: 'silentwolf cybernetic glowing red wolf artwork',
    platform: 'whatsapp',
    framework: 'Baileys MD',
    runtime: 'node-20',
    defaultBranch: 'main',
    installCommand: 'npm install --legacy-peer-deps --ignore-engines',
    buildCommand: '',
    startCommand: 'npm start',
    defaultEnvVars: [
      { key: 'SESSION_ID', label: 'Session ID', placeholder: 'WOLF~...', isSecret: true },
      { key: 'PREFIX', label: 'Command Prefix', placeholder: '.', isSecret: false },
      { key: 'OWNER_NUMBER', label: 'Owner Number', placeholder: '2547...', isSecret: false },
    ],
  },
  {
    id: 'cypherx',
    name: 'CypherX',
    repoFullName: 'Dark-Xploit/CypherX',
    repoUrl: 'https://github.com/Dark-Xploit/CypherX',
    sessionPairUrl: 'https://cypherx-pair.onrender.com',
    sessionPairHost: 'cypherx-pair.onrender.com',
    description:
      'Encrypted-core WhatsApp MD engine by Dark-Xploit supporting extensive admin controls, media converters, and real-time webhook notifications.',
    imageUrl: '/src/assets/images/bot_cypherx_1795010404904.jpg',
    imageAlt: 'CypherX encrypted crimson matrix artwork',
    platform: 'whatsapp',
    framework: 'Baileys MD',
    runtime: 'node-20',
    defaultBranch: 'main',
    installCommand: 'npm install --legacy-peer-deps --ignore-engines',
    buildCommand: '',
    startCommand: 'npm start',
    defaultEnvVars: [
      { key: 'SESSION_ID', label: 'Session ID', placeholder: 'CYPHERX~...', isSecret: true },
      { key: 'PREFIX', label: 'Command Prefix', placeholder: '.', isSecret: false },
      { key: 'OWNER_NUMBER', label: 'Owner Number', placeholder: '234...', isSecret: false },
    ],
  },
  {
    id: 'bwm-xmd-go-v2',
    name: 'BWM-XMD-GO-V2',
    repoFullName: 'Bwmxmdgo/BWM-XMD-GO-V2',
    repoUrl: 'https://github.com/Bwmxmdgo/BWM-XMD-GO-V2',
    sessionPairUrl: 'https://bwm-pair.onrender.com',
    sessionPairHost: 'bwm-pair.onrender.com',
    description:
      'Next-gen BWM-XMD-GO V2 deployment tailored for ultra-fast pairing, group automation, and continuous 24/7 uptime.',
    imageUrl: '/src/assets/images/bot_bwm_xmd_go_1795010405567.jpg',
    imageAlt: 'BWM-XMD-GO-V2 futuristic turbo visor artwork',
    platform: 'whatsapp',
    framework: 'Baileys XMD',
    runtime: 'node-20',
    defaultBranch: 'main',
    installCommand: 'npm install --legacy-peer-deps --ignore-engines',
    buildCommand: '',
    startCommand: 'npm start',
    defaultEnvVars: [
      { key: 'SESSION_ID', label: 'Session ID', placeholder: 'BWM~...', isSecret: true },
      { key: 'PREFIX', label: 'Command Prefix', placeholder: '.', isSecret: false },
      { key: 'OWNER_NUMBER', label: 'Owner Number', placeholder: '2547...', isSecret: false },
    ],
  },
];
