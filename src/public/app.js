'use strict';

const $ = id => document.getElementById(id);
let licenses = [];

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || data.reason || `Erro HTTP ${response.status}`);
  return data;
}

function formatDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString('pt-BR');
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[ch]));
}

function statusFor(item) {
  if (new Date(item.expiresAt).getTime() <= Date.now()) return 'expired';
  return item.status;
}

function render() {
  const query = $('search').value.trim().toLowerCase();
  const filtered = licenses.filter(item => [item.customer, item.id, item.last4, item.status].join(' ').toLowerCase().includes(query));
  $('licenseRows').innerHTML = filtered.map(item => {
    const status = statusFor(item);
    return `<tr>
      <td><strong>${escapeHtml(item.customer)}</strong><br><small>ID: ${escapeHtml(item.id)} · final ${escapeHtml(item.last4)}</small></td>
      <td><span class="status ${status}">${status}</span></td>
      <td>${escapeHtml(formatDate(item.expiresAt))}</td>
      <td>${item.activations}/${item.maxActivations}</td>
      <td>${escapeHtml(formatDate(item.lastSeenAt))}</td>
      <td><div class="actions">
        <button class="secondary" data-action="renew" data-id="${item.id}">Renovar</button>
        <button class="muted" data-action="reset" data-id="${item.id}">Reset HWID</button>
        <button class="${status === 'blocked' ? 'secondary' : 'danger'}" data-action="status" data-status="${status === 'blocked' ? 'active' : 'blocked'}" data-id="${item.id}">${status === 'blocked' ? 'Desbloquear' : 'Bloquear'}</button>
        <button class="danger" data-action="delete" data-id="${item.id}">Excluir</button>
      </div></td>
    </tr>`;
  }).join('') || '<tr><td colspan="6">Nenhuma licença encontrada.</td></tr>';
}

async function load() {
  const data = await api('/api/admin/licenses');
  licenses = data.items;
  $('statTotal').textContent = data.stats.total;
  $('statActive').textContent = data.stats.active;
  $('statBlocked').textContent = data.stats.blocked;
  $('statExpired').textContent = data.stats.expired;
  render();
}

async function checkSession() {
  try {
    await api('/api/admin/session');
    $('loginView').classList.add('hidden');
    $('dashboardView').classList.remove('hidden');
    await load();
  } catch {
    $('loginView').classList.remove('hidden');
    $('dashboardView').classList.add('hidden');
  }
}

$('loginForm').addEventListener('submit', async event => {
  event.preventDefault();
  $('loginError').textContent = '';
  try {
    await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ username: $('username').value, password: $('password').value }) });
    await checkSession();
  } catch (error) { $('loginError').textContent = error.message; }
});
$('logout').addEventListener('click', async () => { await api('/api/admin/logout', { method: 'POST' }); location.reload(); });
$('openCreate').addEventListener('click', () => $('createDialog').showModal());
$('refresh').addEventListener('click', load);
$('search').addEventListener('input', render);
document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));

$('createForm').addEventListener('submit', async event => {
  event.preventDefault();
  const data = await api('/api/admin/licenses', { method: 'POST', body: JSON.stringify({
    customer: $('customer').value,
    days: Number($('days').value),
    maxActivations: Number($('maxActivations').value),
    plan: $('plan').value,
    bindHwid: $('bindHwid').checked,
    notes: $('notes').value
  }) });
  $('createDialog').close();
  $('generatedKey').textContent = data.key;
  $('keyDialog').showModal();
  event.target.reset();
  $('days').value = 30;
  $('maxActivations').value = 1;
  $('bindHwid').checked = true;
  await load();
});
$('copyKey').addEventListener('click', async () => {
  await navigator.clipboard.writeText($('generatedKey').textContent);
  $('copyKey').textContent = 'Copiado';
  setTimeout(() => $('copyKey').textContent = 'Copiar key', 1200);
});
$('licenseRows').addEventListener('click', async event => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const id = button.dataset.id;
  try {
    if (button.dataset.action === 'renew') {
      const days = Number(prompt('Quantos dias adicionar?', '30'));
      if (!days) return;
      await api(`/api/admin/licenses/${id}/renew`, { method: 'POST', body: JSON.stringify({ days }) });
    }
    if (button.dataset.action === 'reset' && confirm('Remover todos os HWIDs vinculados?')) await api(`/api/admin/licenses/${id}/reset-hwid`, { method: 'POST', body: '{}' });
    if (button.dataset.action === 'status') await api(`/api/admin/licenses/${id}/status`, { method: 'POST', body: JSON.stringify({ status: button.dataset.status }) });
    if (button.dataset.action === 'delete' && confirm('Excluir definitivamente esta licença?')) await api(`/api/admin/licenses/${id}`, { method: 'DELETE' });
    await load();
  } catch (error) { alert(error.message); }
});

checkSession();
