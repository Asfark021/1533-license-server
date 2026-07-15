'use strict';

require('dotenv').config();
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { JsonStore } = require('./store');
const { LicenseService, publicLicense } = require('./licenseService');
const { EfiService } = require('./efiService');
const { PaymentService, parsePlans } = require('./paymentService');
const { startDiscordBot } = require('./discordBot');

const PORT = Number(process.env.PORT || 8080);
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me';
const JWT_SECRET = process.env.ADMIN_JWT_SECRET || 'change-this-secret-before-production';
const isProduction = process.env.NODE_ENV === 'production';

async function main() {
  const store = new JsonStore(process.env.DATA_FILE || 'data/licenses.json');
  await store.init();

  const service = new LicenseService(store, {
    privateKeyPath: process.env.LICENSE_PRIVATE_KEY_PATH || 'keys/private.pem',
    offlineGraceHours: process.env.OFFLINE_GRACE_HOURS || 24
  });

  const efi = new EfiService({
    clientId: process.env.EFI_CLIENT_ID,
    clientSecret: process.env.EFI_CLIENT_SECRET,
    pixKey: process.env.EFI_PIX_KEY,
    certPath: process.env.EFI_CERT_PATH,
    certPassword: process.env.EFI_CERT_PASSWORD,
    sandbox: process.env.EFI_SANDBOX
  });

  const payments = new PaymentService({ store, licenses: service, efi, plans: parsePlans(process.env) });

  const app = express();
  app.set('trust proxy', 1);
  app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
  app.use(express.json({ limit: '128kb' }));
  app.use(express.urlencoded({ extended: false }));
  app.use(cookieParser());
  app.use(express.static(path.join(__dirname, 'public')));
  app.use('/assets', express.static(path.resolve('assets')));

  const clientLimiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false });
  const loginLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 15, standardHeaders: true, legacyHeaders: false });

  function adminOnly(req, res, next) {
    try {
      const token = req.cookies.admin_session || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      req.admin = jwt.verify(token, JWT_SECRET);
      next();
    } catch { res.status(401).json({ ok: false, error: 'Não autorizado.' }); }
  }

  const healthPayload = () => ({ ok: true, service: '1533-license-server', efi: efi.enabled, time: new Date().toISOString(), version: '3.0.0' });
  app.get('/health', (_req, res) => res.json(healthPayload()));
  app.get('/api/health', (_req, res) => res.json(healthPayload()));

  app.post('/api/client/activate', clientLimiter, async (req, res) => {
    const result = await service.validate({ key: req.body.key, hwid: req.body.hwid, appVersion: req.body.appVersion, ip: req.ip });
    res.status(result.valid ? 200 : 403).json(result);
  });
  app.post('/api/client/validate', clientLimiter, async (req, res) => {
    const result = await service.validate({ key: req.body.key, hwid: req.body.hwid, appVersion: req.body.appVersion, ip: req.ip });
    res.status(result.valid ? 200 : 403).json(result);
  });

  // A Efí pode enviar o payload diretamente ou em /pix. A confirmação real é
  // sempre consultada novamente na API Efí antes de liberar a licença.
  async function efiWebhook(req, res) {
    res.status(200).json({ ok: true });
    payments.handleWebhook(req.body || {}).then(results => console.log('[EFI WEBHOOK]', results)).catch(error => console.error('[EFI WEBHOOK]', error));
  }
  app.post('/api/efi/webhook', efiWebhook);
  app.post('/api/efi/webhook/pix', efiWebhook);

  app.post('/api/admin/login', loginLimiter, (req, res) => {
    const valid = String(req.body.username || '') === ADMIN_USER && String(req.body.password || '') === ADMIN_PASSWORD;
    if (!valid) return res.status(401).json({ ok: false, error: 'Usuário ou senha inválidos.' });
    const token = jwt.sign({ sub: ADMIN_USER, role: 'admin' }, JWT_SECRET, { expiresIn: '12h' });
    res.cookie('admin_session', token, { httpOnly: true, sameSite: 'strict', secure: isProduction, maxAge: 12 * 3600000 });
    return res.json({ ok: true });
  });
  app.post('/api/admin/logout', (_req, res) => { res.clearCookie('admin_session'); res.json({ ok: true }); });
  app.get('/api/admin/session', adminOnly, (_req, res) => res.json({ ok: true, user: ADMIN_USER }));

  app.get('/api/admin/licenses', adminOnly, (_req, res) => {
    const items = store.list().map(publicLicense); const now = Date.now();
    const stats = { total: items.length, active: items.filter(i => i.status === 'active' && new Date(i.expiresAt).getTime() > now).length, blocked: items.filter(i => i.status === 'blocked').length, expired: items.filter(i => i.status === 'expired' || new Date(i.expiresAt).getTime() <= now).length };
    res.json({ ok: true, items, stats });
  });
  app.post('/api/admin/licenses', adminOnly, async (req, res) => { try { const result = await service.create(req.body || {}); res.status(201).json({ ok: true, ...result }); } catch (error) { res.status(400).json({ ok: false, error: error.message }); } });
  app.post('/api/admin/licenses/:id/renew', adminOnly, async (req, res) => { const item = await service.renew(req.params.id, req.body.days); res.status(item ? 200 : 404).json(item ? { ok: true, item } : { ok: false, error: 'Licença não encontrada.' }); });
  app.post('/api/admin/licenses/:id/status', adminOnly, async (req, res) => { const item = await service.setStatus(req.params.id, req.body.status); res.status(item ? 200 : 404).json(item ? { ok: true, item } : { ok: false, error: 'Licença ou status inválido.' }); });
  app.post('/api/admin/licenses/:id/reset-hwid', adminOnly, async (req, res) => { const item = await service.resetHwid(req.params.id); res.status(item ? 200 : 404).json(item ? { ok: true, item } : { ok: false, error: 'Licença não encontrada.' }); });
  app.delete('/api/admin/licenses/:id', adminOnly, async (req, res) => { const ok = await service.remove(req.params.id); res.status(ok ? 200 : 404).json(ok ? { ok: true } : { ok: false, error: 'Licença não encontrada.' }); });

  app.get('/api/admin/sales', adminOnly, (_req, res) => res.json({ ok: true, items: store.listSales() }));
  app.get('/api/admin/audit', adminOnly, (_req, res) => res.json({ ok: true, items: store.data.audit.slice(0, 500) }));
  app.get('/api/admin/banned-hwids', adminOnly, (_req, res) => res.json({ ok: true, items: store.listBannedHwids() }));
  app.post('/api/admin/banned-hwids', adminOnly, async (req, res) => res.json({ ok: true, item: await store.banHwid(req.body.hwid, req.body.reason, req.admin.sub) }));
  app.delete('/api/admin/banned-hwids/:hwid', adminOnly, async (req, res) => res.json({ ok: await store.unbanHwid(req.params.hwid) }));
  app.post('/api/admin/efi/configure-webhook', adminOnly, async (_req, res) => {
    try {
      const url = String(process.env.EFI_WEBHOOK_URL || '').trim();
      const result = await efi.configureWebhook(url);
      res.json({ ok: true, result });
    } catch (error) { res.status(400).json({ ok: false, error: error.message }); }
  });

  app.use((_req, res) => res.sendFile(path.join(__dirname, 'public/index.html')));

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`[WEB] 1533 License Server na porta ${PORT}`);
    if (process.env.PUBLIC_URL) console.log(`[WEB] URL pública configurada: ${process.env.PUBLIC_URL}`);
  });
  const discord = await startDiscordBot({
    token: process.env.DISCORD_TOKEN, clientId: process.env.DISCORD_CLIENT_ID, guildId: process.env.DISCORD_GUILD_ID,
    adminIds: process.env.DISCORD_ADMIN_IDS, service, payments, store,
    logChannelId: process.env.DISCORD_LOG_CHANNEL_ID, salesChannelId: process.env.DISCORD_SALES_CHANNEL_ID,
    supportUrl: process.env.SUPPORT_URL, logoUrl: process.env.BRAND_LOGO_URL
  });

  const shutdown = async () => { server.close(); if (discord?.client) discord.client.destroy(); await efi.close().catch(() => {}); process.exit(0); };
  process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
}

main().catch(error => { console.error('[FATAL]', error); process.exit(1); });
