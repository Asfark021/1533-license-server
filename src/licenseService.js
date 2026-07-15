'use strict';

const crypto = require('crypto');
const fs = require('fs');

const KEY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function sha256(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
function randomBlock(length = 4) {
  let out = '';
  for (let i = 0; i < length; i += 1) out += KEY_ALPHABET[crypto.randomInt(0, KEY_ALPHABET.length)];
  return out;
}
function generatePlainKey() { return `1533-${randomBlock()}-${randomBlock()}-${randomBlock()}-${randomBlock()}`; }
function normalizeKey(value) { return String(value || '').trim().toUpperCase(); }
function maskKey(value) { const key = normalizeKey(value); return key ? `1533-****-****-****-${key.slice(-4)}` : '1533-****'; }

function publicLicense(item) {
  return {
    id: item.id,
    customer: item.customer,
    discordUserId: item.discordUserId || null,
    discordUsername: item.discordUsername || null,
    plan: item.plan,
    status: item.status,
    expiresAt: item.expiresAt,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    firstActivatedAt: item.firstActivatedAt || null,
    last4: item.last4,
    maskedKey: `1533-****-****-****-${item.last4}`,
    bindHwid: item.bindHwid,
    maxActivations: item.maxActivations,
    activations: item.hwids.length,
    hwids: item.hwids,
    lastSeenAt: item.lastSeenAt || null,
    notes: item.notes || '',
    source: item.source || 'admin'
  };
}

class LicenseService {
  constructor(store, options) {
    this.store = store;
    this.privateKey = fs.readFileSync(options.privateKeyPath, 'utf8');
    this.offlineGraceHours = Math.max(1, Number(options.offlineGraceHours || 24));
    this.onEvent = typeof options.onEvent === 'function' ? options.onEvent : async () => {};
  }

  setEventHandler(handler) { this.onEvent = typeof handler === 'function' ? handler : async () => {}; }

  async create({ customer, days, plan, bindHwid = true, maxActivations = 1, notes = '', discordUserId = '', discordUsername = '', source = 'admin', saleId = null }) {
    const validDays = Math.min(3650, Math.max(1, Number(days || 30)));
    const plainKey = generatePlainKey();
    const now = new Date();
    const item = {
      id: crypto.randomUUID(), keyHash: sha256(plainKey), last4: plainKey.slice(-4),
      customer: String(customer || 'Cliente').trim().slice(0, 100),
      discordUserId: String(discordUserId || ''), discordUsername: String(discordUsername || '').slice(0, 100),
      plan: String(plan || `${validDays} dias`).trim().slice(0, 60), status: 'active',
      expiresAt: new Date(now.getTime() + validDays * 86400000).toISOString(),
      bindHwid: Boolean(bindHwid), maxActivations: Math.min(20, Math.max(1, Number(maxActivations || 1))),
      hwids: [], notes: String(notes || '').slice(0, 500), source, saleId,
      createdAt: now.toISOString(), updatedAt: now.toISOString(), lastSeenAt: null, firstActivatedAt: null
    };
    await this.store.insert(item);
    await this.store.audit('license.created', { licenseId: item.id, customer: item.customer, source, discordUserId: item.discordUserId });
    await this.onEvent('license.created', { license: publicLicense(item), plainKey });
    return { key: plainKey, license: publicLicense(item) };
  }

  async validate({ key, hwid, appVersion, ip }) {
    const normalized = normalizeKey(key);
    if (!/^1533-[A-Z2-9]{4}(?:-[A-Z2-9]{4}){3}$/.test(normalized)) return { valid: false, code: 'INVALID_KEY', reason: 'Formato de licença inválido.' };
    const item = this.store.getByHash(sha256(normalized));
    if (!item) return { valid: false, code: 'NOT_FOUND', reason: 'Licença não encontrada.' };
    if (item.status !== 'active') return { valid: false, code: 'BLOCKED', reason: 'Licença bloqueada.' };
    const expires = new Date(item.expiresAt).getTime();
    if (!Number.isFinite(expires) || Date.now() >= expires) {
      if (item.status !== 'expired') await this.store.update(item.id, { status: 'expired' });
      return { valid: false, code: 'EXPIRED', reason: 'Licença vencida.', expiresAt: item.expiresAt };
    }
    const machine = String(hwid || '').trim().toUpperCase();
    if (!machine || machine.length < 12) return { valid: false, code: 'INVALID_HWID', reason: 'HWID inválido.' };
    if (this.store.isHwidBanned(machine)) return { valid: false, code: 'HWID_BANNED', reason: 'Este computador está bloqueado.' };

    const firstActivation = !item.firstActivatedAt;
    if (item.bindHwid && !item.hwids.includes(machine)) {
      if (item.hwids.length >= item.maxActivations) return { valid: false, code: 'HWID_LIMIT', reason: 'Esta licença já está vinculada ao limite de computadores.' };
      item.hwids.push(machine);
    }

    const now = new Date();
    item.lastSeenAt = now.toISOString();
    item.lastIp = String(ip || '').slice(0, 100);
    item.lastAppVersion = String(appVersion || '').slice(0, 30);
    if (firstActivation) item.firstActivatedAt = now.toISOString();
    await this.store.update(item.id, item);

    if (firstActivation) {
      const redeemed = { licenseId: item.id, key: maskKey(normalized), last4: item.last4, userId: item.discordUserId || '', username: item.discordUsername || item.customer, redeemedAt: now.toISOString(), hwid: machine, plan: item.plan };
      await this.store.audit('license.redeemed', redeemed);
      await this.onEvent('license.redeemed', redeemed);
    }

    const offlineUntil = new Date(Math.min(expires, now.getTime() + this.offlineGraceHours * 3600000));
    const payload = { v: 1, licenseId: item.id, customer: item.customer, plan: item.plan, hwid: machine, expiresAt: item.expiresAt, offlineUntil: offlineUntil.toISOString(), issuedAt: now.toISOString() };
    const payloadBuffer = Buffer.from(JSON.stringify(payload));
    const signature = crypto.sign(null, payloadBuffer, this.privateKey);
    const lease = `L1533.${payloadBuffer.toString('base64url')}.${signature.toString('base64url')}`;
    return { valid: true, lease, customer: item.customer, plan: item.plan, expiresAt: item.expiresAt, daysRemaining: Math.max(0, Math.ceil((expires - Date.now()) / 86400000)) };
  }

  async renew(id, days) {
    const item = this.store.getById(id); if (!item) return null;
    const extra = Math.min(3650, Math.max(1, Number(days || 30)));
    const base = Math.max(Date.now(), new Date(item.expiresAt).getTime() || Date.now());
    const updated = await this.store.update(id, { expiresAt: new Date(base + extra * 86400000).toISOString(), status: 'active' });
    await this.store.audit('license.renewed', { licenseId: id, days: extra });
    await this.onEvent('license.renewed', { license: publicLicense(updated), days: extra });
    return publicLicense(updated);
  }
  async setStatus(id, status) {
    if (!['active', 'blocked', 'expired'].includes(status)) return null;
    const updated = await this.store.update(id, { status });
    if (updated) { await this.store.audit('license.status', { licenseId: id, status }); await this.onEvent('license.status', { license: publicLicense(updated), status }); }
    return updated ? publicLicense(updated) : null;
  }
  async resetHwid(id) {
    const updated = await this.store.update(id, { hwids: [] });
    if (updated) { await this.store.audit('license.hwid_reset', { licenseId: id }); await this.onEvent('license.hwid_reset', { license: publicLicense(updated) }); }
    return updated ? publicLicense(updated) : null;
  }
  async remove(id) {
    const item = this.store.getById(id);
    const ok = await this.store.remove(id);
    if (ok) { await this.store.audit('license.deleted', { licenseId: id }); await this.onEvent('license.deleted', { license: item ? publicLicense(item) : { id } }); }
    return ok;
  }
}

module.exports = { LicenseService, publicLicense, normalizeKey, maskKey };
