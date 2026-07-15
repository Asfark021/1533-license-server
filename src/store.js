'use strict';

const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

class JsonStore {
  constructor(filename) {
    this.filename = path.resolve(filename);
    this.data = { licenses: [], sales: [], bannedHwids: [], coupons: [], couponClaims: [], audit: [] };
    this.queue = Promise.resolve();
  }

  async init() {
    await fs.mkdir(path.dirname(this.filename), { recursive: true });
    try {
      const parsed = JSON.parse(await fs.readFile(this.filename, 'utf8'));
      if (!parsed || !Array.isArray(parsed.licenses)) throw new Error('Formato inválido');
      this.data = {
        licenses: parsed.licenses,
        sales: Array.isArray(parsed.sales) ? parsed.sales : [],
        bannedHwids: Array.isArray(parsed.bannedHwids) ? parsed.bannedHwids : [],
        coupons: Array.isArray(parsed.coupons) ? parsed.coupons : [],
        couponClaims: Array.isArray(parsed.couponClaims) ? parsed.couponClaims : [],
        audit: Array.isArray(parsed.audit) ? parsed.audit : []
      };
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn('[STORE] Banco recriado:', error.message);
      await this.save();
    }
  }

  async save() {
    this.queue = this.queue.then(async () => {
      const temp = `${this.filename}.tmp`;
      await fs.writeFile(temp, JSON.stringify(this.data, null, 2));
      await fs.rename(temp, this.filename);
    });
    return this.queue;
  }

  list() { return [...this.data.licenses]; }
  getById(id) { return this.data.licenses.find(item => item.id === id) || null; }
  getByHash(keyHash) { return this.data.licenses.find(item => item.keyHash === keyHash) || null; }
  getSaleByTxid(txid) { return this.data.sales.find(item => item.txid === txid) || null; }
  getSaleById(id) { return this.data.sales.find(item => item.id === id) || null; }
  listSales() { return [...this.data.sales]; }
  listBannedHwids() { return [...this.data.bannedHwids]; }
  isHwidBanned(hwid) { return this.data.bannedHwids.some(item => item.hwid === String(hwid).toUpperCase()); }

  listCoupons() { return [...this.data.coupons]; }
  getCoupon(code) {
    const normalized = String(code || '').trim().toUpperCase();
    return this.data.coupons.find(item => item.code === normalized) || null;
  }
  getCouponById(id) { return this.data.coupons.find(item => item.id === id) || null; }
  getCouponClaim(userId) { return this.data.couponClaims.find(item => item.userId === String(userId)) || null; }

  async insert(license) { this.data.licenses.unshift(license); await this.save(); return license; }
  async update(id, patch) {
    const item = this.getById(id); if (!item) return null;
    Object.assign(item, patch, { updatedAt: new Date().toISOString() });
    await this.save(); return item;
  }
  async remove(id) {
    const index = this.data.licenses.findIndex(item => item.id === id);
    if (index < 0) return false;
    this.data.licenses.splice(index, 1); await this.save(); return true;
  }

  async insertSale(sale) { this.data.sales.unshift(sale); await this.save(); return sale; }
  async updateSale(id, patch) {
    const item = this.getSaleById(id); if (!item) return null;
    Object.assign(item, patch, { updatedAt: new Date().toISOString() });
    await this.save(); return item;
  }

  async createCoupon({ code, discountPercent, maxUses = 1, expiresAt = null, createdBy = '' }) {
    const normalized = String(code || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 32);
    const percent = Math.min(100, Math.max(1, Number(discountPercent || 0)));
    const uses = Math.min(100000, Math.max(1, Number(maxUses || 1)));
    if (normalized.length < 3) throw new Error('O cupom precisa ter pelo menos 3 caracteres.');
    if (this.getCoupon(normalized)) throw new Error('Já existe um cupom com esse código.');
    const item = {
      id: crypto.randomUUID(), code: normalized, discountPercent: percent, maxUses: uses,
      usedCount: 0, status: 'active', expiresAt: expiresAt || null,
      createdBy: String(createdBy || ''), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    };
    this.data.coupons.unshift(item); await this.save(); return item;
  }

  validateCoupon(code) {
    const coupon = this.getCoupon(code);
    if (!coupon) return { valid: false, reason: 'Cupom não encontrado.' };
    if (coupon.status !== 'active') return { valid: false, reason: 'Cupom desativado.' };
    if (coupon.expiresAt && Date.now() >= new Date(coupon.expiresAt).getTime()) return { valid: false, reason: 'Cupom vencido.' };
    if (Number(coupon.usedCount || 0) >= Number(coupon.maxUses || 0)) return { valid: false, reason: 'Cupom atingiu o limite de usos.' };
    return { valid: true, coupon };
  }

  async claimCoupon(userId, code) {
    const check = this.validateCoupon(code);
    if (!check.valid) throw new Error(check.reason);
    const normalizedUserId = String(userId);
    this.data.couponClaims = this.data.couponClaims.filter(item => item.userId !== normalizedUserId);
    this.data.couponClaims.push({ userId: normalizedUserId, couponCode: check.coupon.code, claimedAt: new Date().toISOString() });
    await this.save();
    return check.coupon;
  }

  getValidClaimedCoupon(userId) {
    const claim = this.getCouponClaim(userId);
    if (!claim) return null;
    const check = this.validateCoupon(claim.couponCode);
    return check.valid ? check.coupon : null;
  }

  async consumeClaimedCoupon(userId) {
    const claim = this.getCouponClaim(userId);
    if (!claim) return null;
    const check = this.validateCoupon(claim.couponCode);
    this.data.couponClaims = this.data.couponClaims.filter(item => item.userId !== String(userId));
    if (!check.valid) { await this.save(); return null; }
    check.coupon.usedCount = Number(check.coupon.usedCount || 0) + 1;
    check.coupon.updatedAt = new Date().toISOString();
    await this.save();
    return check.coupon;
  }

  async removeCoupon(codeOrId) {
    const value = String(codeOrId || '').trim().toUpperCase();
    const before = this.data.coupons.length;
    this.data.coupons = this.data.coupons.filter(item => item.id !== codeOrId && item.code !== value);
    this.data.couponClaims = this.data.couponClaims.filter(item => item.couponCode !== value);
    if (before === this.data.coupons.length) return false;
    await this.save(); return true;
  }

  async setCouponStatus(codeOrId, status) {
    if (!['active', 'disabled'].includes(status)) return null;
    const value = String(codeOrId || '').trim().toUpperCase();
    const item = this.data.coupons.find(c => c.id === codeOrId || c.code === value);
    if (!item) return null;
    item.status = status; item.updatedAt = new Date().toISOString(); await this.save(); return item;
  }

  async banHwid(hwid, reason = '', adminId = '') {
    const normalized = String(hwid || '').trim().toUpperCase();
    if (!normalized) return null;
    const existing = this.data.bannedHwids.find(item => item.hwid === normalized);
    if (existing) return existing;
    const item = { hwid: normalized, reason: String(reason).slice(0, 300), adminId: String(adminId), createdAt: new Date().toISOString() };
    this.data.bannedHwids.unshift(item); await this.save(); return item;
  }
  async unbanHwid(hwid) {
    const normalized = String(hwid || '').trim().toUpperCase();
    const before = this.data.bannedHwids.length;
    this.data.bannedHwids = this.data.bannedHwids.filter(item => item.hwid !== normalized);
    if (before === this.data.bannedHwids.length) return false;
    await this.save(); return true;
  }
  async audit(action, details = {}) {
    this.data.audit.unshift({ id: crypto.randomUUID(), action, details, at: new Date().toISOString() });
    this.data.audit = this.data.audit.slice(0, 3000); await this.save();
  }
}

module.exports = { JsonStore };
