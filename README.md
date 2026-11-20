---
title: Lyrihost
emoji: ⚡
colorFrom: red
colorTo: pink
sdk: docker
app_port: 7860
pinned: false
---

# Lyrihost — Bot Deployment, Coins & Security Console

Full-stack TypeScript control plane (`React + Vite + Express + WebSockets + SQLite WAL + Cloud Firestore`) for deploying and managing multi-platform bots (WhatsApp Baileys, Discord, Telegram, Slack, Custom) with M-Pesa STK Push coin billing and Google Cloud Firestore durable persistence.

## Hugging Face Spaces Configuration

- **SDK**: Docker (`app_port: 7860`)
- **Recommended Hardware**: `CPU basic` (16 GB RAM) or persistent storage enabled for `/app/data` if you want local SQLite WAL files retained across container rebuilds in addition to Cloud Firestore sync.
- **Environment Variables**: Set `RESEND_API_KEY` in your Space or Render **Environment** settings for transactional/OTP emails via Resend.
- **Firebase Authorized Domain**:
  - Add your deployed domain (`<your-service>.onrender.com`, `<your-service>.koyeb.app`, or `<your-space>.hf.space`) under **Firebase Console → Authentication → Settings → Authorized domains** so **Connect Google Cloud Sync (Firestore)** works on your live URL.
