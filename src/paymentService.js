'use strict';

const crypto = require('crypto');

function parsePlans(env) {
  const defaults = [
    { id: '7d', name: '7 dias', days: 7, price: Number(env.PLAN_7_DAYS_PRICE || 10) },
    { id: '30d', name: '30 dias', days: 30, price: Number(env.PLAN_30_DAYS_PRICE || 25) },
    { id: '90d', name: '90 dias', days: 90, price: Number(env.PLAN_90_DAYS_PRICE || 60) },
    { id: 'life', name: 'Vitalícia', days: Number(env.PLAN_LIFETIME_DAYS || 3650), price: Number(env.PLAN_LIFETIME_PRICE || 120) }
  ];
  return defaults.filter(plan => Number.isFinite(plan.price) && plan.price > 0);
}

class PaymentService {
  constructor({ store, licenses, efi, plans, onPaid }) {
    this.store = store; this.licenses = licenses; this.efi = efi; this.plans = plans; this.onPaid = onPaid || (async () => {});
  }
  getPlan(id) { return this.plans.find(plan => plan.id === id) || null; }

  async createSale({ planId, discordUserId, discordUsername }) {
    const plan = this.getPlan(planId);
    if (!plan) throw new Error('Plano inválido.');
    const userId = String(discordUserId || '');
    if (!userId) throw new Error('Usuário do Discord inválido.');

    const pending = this.store.listSales().find(s => s?.discordUserId === userId && s.planId === plan.id && s.status === 'pending' && new Date(s.expiresAt).getTime() > Date.now());
    if (pending) return pending;

    const coupon = this.store.getValidClaimedCoupon(userId);
    const discountPercent = coupon ? Number(coupon.discountPercent || 0) : 0;
    const originalAmount = Number(plan.price);
    const finalAmount = Math.max(0.01, Number((originalAmount * (1 - discountPercent / 100)).toFixed(2)));

    const charge = await this.efi.createCharge({ amount: finalAmount, description: `1533 Dumps - ${plan.name}${coupon ? ` - Cupom ${coupon.code}` : ''}` });
    if (coupon) await this.store.consumeClaimedCoupon(userId);
    const now = new Date();
    const sale = {
      id: crypto.randomUUID(), txid: charge.txid, status: 'pending', planId: plan.id, planName: plan.name,
      days: plan.days, amount: finalAmount, originalAmount, discountPercent,
      couponCode: coupon?.code || null, couponId: coupon?.id || null,
      discordUserId: userId, discordUsername: String(discordUsername || ''),
      copyPaste: charge.copyPaste, imageData: charge.imageData, locationId: charge.locationId,
      createdAt: now.toISOString(), updatedAt: now.toISOString(), expiresAt: new Date(now.getTime() + charge.expiresIn * 1000).toISOString(), paidAt: null, licenseId: null
    };
    await this.store.insertSale(sale);
    await this.store.audit('sale.created', { saleId: sale.id, txid: sale.txid, userId: sale.discordUserId, plan: sale.planName, amount: sale.amount, couponCode: sale.couponCode });
    return sale;
  }

  async confirmTxid(txid) {
    const sale = this.store.getSaleByTxid(txid);
    if (!sale) return { ok: false, reason: 'Venda não encontrada.' };
    if (sale.status === 'paid') return { ok: true, alreadyPaid: true, sale };
    const detail = await this.efi.detailCharge(txid);
    if (detail.status !== 'CONCLUIDA') return { ok: false, reason: `Pagamento ainda não concluído (${detail.status || 'desconhecido'}).`, sale };
    const paidValue = Number(detail.pix?.[0]?.valor || detail.valor?.original || 0);
    if (Math.abs(paidValue - Number(sale.amount)) > 0.009) throw new Error('Valor confirmado pela Efí é diferente do valor da venda.');
    const generated = await this.licenses.create({
      customer: sale.discordUsername || `Discord ${sale.discordUserId || 'não informado'}`, days: sale.days, plan: sale.planName,
      bindHwid: true, maxActivations: 1, discordUserId: sale.discordUserId || '', discordUsername: sale.discordUsername || '',
      source: 'efi-discord', saleId: sale.id
    });
    const updated = await this.store.updateSale(sale.id, { status: 'paid', paidAt: new Date().toISOString(), licenseId: generated.license.id });
    await this.store.audit('sale.paid', { saleId: sale.id, txid, userId: sale.discordUserId || '', licenseId: generated.license.id, amount: sale.amount, couponCode: sale.couponCode || null });
    await this.onPaid({ sale: updated, generated });
    return { ok: true, sale: updated, generated };
  }

  async handleWebhook(payload) {
    const txids = new Set();
    for (const pix of Array.isArray(payload?.pix) ? payload.pix : []) if (pix?.txid) txids.add(pix.txid);
    if (payload?.txid) txids.add(payload.txid);
    const results = [];
    for (const txid of txids) results.push(await this.confirmTxid(txid).catch(error => ({ ok: false, txid, reason: error.message })));
    return results;
  }
}

module.exports = { PaymentService, parsePlans };
