'use strict';

const fs = require('fs');
const crypto = require('crypto');
const { Agent, request } = require('undici');

function money(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error('Valor do plano inválido.');
  return number.toFixed(2);
}

class EfiService {
  constructor(options = {}) {
    this.clientId = String(options.clientId || '').trim();
    this.clientSecret = String(options.clientSecret || '').trim();
    this.pixKey = String(options.pixKey || '').trim();
    this.certPath = String(options.certPath || '').trim();
    this.certPassword = String(options.certPassword || '');
    this.sandbox = String(options.sandbox).toLowerCase() === 'true' || options.sandbox === true;
    this.baseUrl = this.sandbox ? 'https://pix-h.api.efipay.com.br' : 'https://pix.api.efipay.com.br';
    this.enabled = Boolean(this.clientId && this.clientSecret && this.pixKey && this.certPath && fs.existsSync(this.certPath));
    this.token = null;
    this.tokenExpiresAt = 0;
    this.agent = this.enabled ? new Agent({ connect: { pfx: fs.readFileSync(this.certPath), passphrase: this.certPassword || undefined, rejectUnauthorized: true } }) : null;
  }

  async close() { if (this.agent) await this.agent.close(); }

  async oauth() {
    if (!this.enabled) throw new Error('Efí não configurada. Preencha as credenciais e o certificado no .env.');
    if (this.token && Date.now() < this.tokenExpiresAt - 60_000) return this.token;
    const auth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
    const response = await request(`${this.baseUrl}/oauth/token`, {
      method: 'POST', dispatcher: this.agent,
      headers: { authorization: `Basic ${auth}`, 'content-type': 'application/json' },
      body: JSON.stringify({ grant_type: 'client_credentials' })
    });
    const payload = await response.body.json().catch(() => ({}));
    if (response.statusCode < 200 || response.statusCode >= 300) throw new Error(`Efí OAuth ${response.statusCode}: ${payload.mensagem || payload.error_description || 'falha na autenticação'}`);
    this.token = payload.access_token;
    this.tokenExpiresAt = Date.now() + Number(payload.expires_in || 3600) * 1000;
    return this.token;
  }

  async api(method, endpoint, body) {
    const token = await this.oauth();
    const response = await request(`${this.baseUrl}${endpoint}`, {
      method, dispatcher: this.agent,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.body.text();
    let payload = {};
    try { payload = text ? JSON.parse(text) : {}; } catch { payload = { raw: text }; }
    if (response.statusCode < 200 || response.statusCode >= 300) throw new Error(`Efí ${response.statusCode}: ${payload.mensagem || payload.nome || payload.error || text || 'erro desconhecido'}`);
    return payload;
  }

  async createCharge({ amount, description, expiresIn = 1800 }) {
    const txid = crypto.randomBytes(16).toString('hex').slice(0, 26);
    const charge = await this.api('PUT', `/v2/cob/${txid}`, {
      calendario: { expiracao: Number(expiresIn) },
      valor: { original: money(amount) },
      chave: this.pixKey,
      solicitacaoPagador: String(description || 'Licença 1533 Dumps').slice(0, 140)
    });
    if (!charge.loc?.id) throw new Error('A Efí não retornou o identificador do QR Code.');
    const qr = await this.api('GET', `/v2/loc/${charge.loc.id}/qrcode`);
    return { txid: charge.txid || txid, status: charge.status, locationId: charge.loc.id, copyPaste: qr.qrcode, imageData: qr.imagemQrcode, expiresIn: Number(expiresIn), raw: charge };
  }

  async detailCharge(txid) { return this.api('GET', `/v2/cob/${encodeURIComponent(txid)}`); }

  async configureWebhook(url) {
    if (!url) throw new Error('URL do webhook não informada.');
    return this.api('PUT', `/v2/webhook/${encodeURIComponent(this.pixKey)}`, { webhookUrl: url });
  }
}

module.exports = { EfiService };
