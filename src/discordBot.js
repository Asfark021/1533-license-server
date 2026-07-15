'use strict';

const path = require('path');
const {
  Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, PermissionFlagsBits, Events, MessageFlags,
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder,
  TextInputStyle, AttachmentBuilder
} = require('discord.js');

function isAdmin(userId, allowedIds) { return allowedIds.has(String(userId)); }
function unix(date) { return Math.floor(new Date(date).getTime() / 1000); }
function truncate(value, max = 1000) { const s = String(value || ''); return s.length > max ? `${s.slice(0, max - 3)}...` : s; }

function adminPanelEmbed(logoUrl) {
  const embed = new EmbedBuilder().setTitle('🔐 1533 Dumps — Gerenciamento').setDescription('Gerencie licenças, HWIDs e consulte o sistema pelos botões ou comandos abaixo.').setColor(0x8b2cf5)
    .addFields(
      { name: 'Licenças', value: 'Gerar, renovar, bloquear, excluir e consultar keys.', inline: true },
      { name: 'Computadores', value: 'Resetar, banir e desbanir HWIDs.', inline: true },
      { name: 'Auditoria', value: 'Logs privados de vendas, resgates e ações administrativas.', inline: true }
    );
  if (logoUrl) embed.setImage(logoUrl);
  return embed;
}

function salesPanelEmbed(plans, logoUrl) {
  const prices = plans.map(p => `**${p.name}:** R$ ${p.price.toFixed(2).replace('.', ',')}`).join('\n');
  const embed = new EmbedBuilder().setTitle('🛒 1533 Dumps — Licenças').setColor(0x8b2cf5)
    .setDescription('Aplicativo para Windows com interface moderna para organizar e acompanhar downloads de recursos, selecionar itens específicos, ignorar arquivos stream e visualizar progresso, velocidade e tempo estimado em tempo real.\n\nEscolha um plano abaixo. Após a confirmação do Pix pela **Efí**, sua key será criada e enviada automaticamente no privado.')
    .addFields({ name: 'Planos disponíveis', value: prices || 'Nenhum plano configurado.' }, { name: 'Ativação', value: 'A licença é vinculada ao primeiro computador no resgate.', inline: true }, { name: 'Entrega', value: 'Automática após o pagamento aprovado.', inline: true });
  if (logoUrl) embed.setImage(logoUrl);
  return embed;
}

function salesButtons(plans) {
  const rows = [];
  for (let i = 0; i < plans.length; i += 4) {
    rows.push(new ActionRowBuilder().addComponents(plans.slice(i, i + 4).map(plan => new ButtonBuilder().setCustomId(`buy:${plan.id}`).setLabel(plan.name).setEmoji('🛒').setStyle(ButtonStyle.Primary))));
  }
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('sale:coupon').setLabel('Usar cupom').setEmoji('🎟️').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('sale:check').setLabel('Consultar pagamento').setEmoji('🔎').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('sale:support').setLabel('Suporte').setEmoji('🎧').setStyle(ButtonStyle.Secondary)
  ));
  return rows;
}

function adminButtons() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('admin:create').setLabel('Gerar Key').setEmoji('🔑').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('admin:lookup').setLabel('Consultar').setEmoji('🔎').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('admin:list').setLabel('Listar').setEmoji('📋').setStyle(ButtonStyle.Secondary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('admin:renew').setLabel('Renovar').setEmoji('♻️').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('admin:reset').setLabel('Resetar HWID').setEmoji('💻').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('admin:block').setLabel('Bloquear/Desbloquear').setEmoji('🚫').setStyle(ButtonStyle.Danger)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('admin:delete').setLabel('Excluir Key').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('admin:banhwid').setLabel('Banir HWID').setEmoji('⛔').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('admin:unbanhwid').setLabel('Desbanir HWID').setEmoji('✅').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('admin:coupon').setLabel('Gerar Cupom').setEmoji('🎟️').setStyle(ButtonStyle.Primary)
    )
  ];
}

function makeModal(id, title, fields) {
  const modal = new ModalBuilder().setCustomId(id).setTitle(title);
  modal.addComponents(fields.map(field => new ActionRowBuilder().addComponents(
    new TextInputBuilder().setCustomId(field.id).setLabel(field.label).setStyle(field.style || TextInputStyle.Short).setRequired(field.required !== false).setPlaceholder(field.placeholder || '').setValue(field.value || '')
  )));
  return modal;
}

async function startDiscordBot({ token, clientId, guildId, adminIds, service, payments, store, logChannelId, salesChannelId, supportUrl, logoUrl }) {
  if (!token || !clientId || !guildId) {
    console.log('[DISCORD] Desativado: configure DISCORD_TOKEN, DISCORD_CLIENT_ID e DISCORD_GUILD_ID.');
    return null;
  }
  const allowed = new Set(String(adminIds || '').split(',').map(v => v.trim()).filter(Boolean));
  const adminCommand = cmd => cmd.setDefaultMemberPermissions(PermissionFlagsBits.Administrator);
  const commands = [
    adminCommand(new SlashCommandBuilder().setName('paineladmin').setDescription('Publica o painel administrativo de licenças')),
    adminCommand(new SlashCommandBuilder().setName('painelvendas').setDescription('Publica o painel público de vendas')),
    adminCommand(new SlashCommandBuilder().setName('gerarkey').setDescription('Gera uma licença').addStringOption(o => o.setName('cliente').setDescription('Cliente').setRequired(true)).addIntegerOption(o => o.setName('dias').setDescription('Dias').setRequired(true).setMinValue(1).setMaxValue(3650)).addUserOption(o => o.setName('usuario').setDescription('Usuário do Discord'))),
    adminCommand(new SlashCommandBuilder().setName('infokey').setDescription('Consulta uma licença pelo ID').addStringOption(o => o.setName('id').setDescription('ID da licença').setRequired(true))),
    adminCommand(new SlashCommandBuilder().setName('renovarkey').setDescription('Renova uma licença').addStringOption(o => o.setName('id').setDescription('ID').setRequired(true)).addIntegerOption(o => o.setName('dias').setDescription('Dias adicionais').setRequired(true).setMinValue(1).setMaxValue(3650))),
    adminCommand(new SlashCommandBuilder().setName('bloquekey').setDescription('Bloqueia uma licença').addStringOption(o => o.setName('id').setDescription('ID').setRequired(true))),
    adminCommand(new SlashCommandBuilder().setName('desbloquekey').setDescription('Desbloqueia uma licença').addStringOption(o => o.setName('id').setDescription('ID').setRequired(true))),
    adminCommand(new SlashCommandBuilder().setName('excluirkey').setDescription('Exclui uma licença').addStringOption(o => o.setName('id').setDescription('ID').setRequired(true))),
    adminCommand(new SlashCommandBuilder().setName('resetarhwid').setDescription('Reseta os HWIDs').addStringOption(o => o.setName('id').setDescription('ID').setRequired(true))),
    adminCommand(new SlashCommandBuilder().setName('banirhwid').setDescription('Bane um HWID').addStringOption(o => o.setName('hwid').setDescription('HWID').setRequired(true)).addStringOption(o => o.setName('motivo').setDescription('Motivo'))),
    adminCommand(new SlashCommandBuilder().setName('desbanirhwid').setDescription('Desbane um HWID').addStringOption(o => o.setName('hwid').setDescription('HWID').setRequired(true))),
    adminCommand(new SlashCommandBuilder().setName('listarkeys').setDescription('Lista todas as licenças')),
    adminCommand(new SlashCommandBuilder().setName('gerarcupom').setDescription('Gera um cupom de desconto').addStringOption(o => o.setName('codigo').setDescription('Código do cupom').setRequired(true)).addIntegerOption(o => o.setName('desconto').setDescription('Desconto em porcentagem').setRequired(true).setMinValue(1).setMaxValue(100)).addIntegerOption(o => o.setName('usos').setDescription('Quantidade máxima de usos').setRequired(true).setMinValue(1).setMaxValue(100000)).addIntegerOption(o => o.setName('dias').setDescription('Validade em dias').setRequired(false).setMinValue(1).setMaxValue(3650))),
    adminCommand(new SlashCommandBuilder().setName('listarcupons').setDescription('Lista todos os cupons')),
    adminCommand(new SlashCommandBuilder().setName('excluircupom').setDescription('Exclui um cupom').addStringOption(o => o.setName('codigo').setDescription('Código do cupom').setRequired(true))),
    new SlashCommandBuilder().setName('consultarpagamento').setDescription('Consulta um pagamento Pix').addStringOption(o => o.setName('txid').setDescription('TXID informado na cobrança').setRequired(true))
  ].map(c => c.toJSON());

  const rest = new REST({ version: '10' }).setToken(token);
  await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  async function logEvent(event, data) {
    if (!logChannelId) return;
    const channel = await client.channels.fetch(logChannelId).catch(() => null);
    if (!channel?.isTextBased()) return;
    const embeds = {
      'license.redeemed': new EmbedBuilder().setTitle('🔑 KEY RESGATADA').setColor(0x27c96f).addFields(
        { name: 'Key', value: `\`${data.key}\`` },
        { name: 'Usuário', value: data.userId ? `<@${data.userId}> (\`${data.userId}\`)` : truncate(data.username || 'Não informado') },
        { name: 'Dia resgatado', value: `<t:${unix(data.redeemedAt)}:F>` },
        { name: 'HWID', value: `\`${truncate(data.hwid, 1000)}\`` },
        { name: 'Plano', value: data.plan || 'Não informado' }
      ),
      'sale.paid': new EmbedBuilder().setTitle('💰 VENDA APROVADA').setColor(0x27c96f).addFields(
        { name: 'Usuário', value: data?.sale?.discordUserId ? `<@${data.sale.discordUserId}>` : 'Não informado' }, { name: 'Plano', value: data?.sale?.planName || 'Não informado', inline: true },
        { name: 'Valor', value: `R$ ${Number(data?.sale?.amount || 0).toFixed(2).replace('.', ',')}`, inline: true }, { name: 'TXID', value: `\`${data?.sale?.txid || 'não informado'}\`` }
      )
    };
    const embed = embeds[event];
    if (embed) await channel.send({ embeds: [embed.setTimestamp()] }).catch(() => {});
  }

  service.setEventHandler(logEvent);
  payments.onPaid = async ({ sale, generated }) => {
    if (!sale) return;
    const userId = sale.discordUserId || '';
    const user = userId ? await client.users.fetch(userId).catch(() => null) : null;
    if (user) {
      await user.send({ embeds: [new EmbedBuilder().setTitle('✅ Pagamento aprovado').setColor(0x27c96f).setDescription('Sua licença do **1533 Dumps** foi criada automaticamente. Guarde esta key em local seguro.').addFields(
        { name: 'Plano', value: sale.planName, inline: true }, { name: 'Valor', value: `R$ ${Number(sale.amount).toFixed(2).replace('.', ',')}`, inline: true },
        { name: 'Sua key', value: `\`${generated.key}\`` }, { name: 'ID da licença', value: `\`${generated.license.id}\`` }
      )] }).catch(async () => { await logEvent('sale.dm_failed', { sale }); });
    }
    await logEvent('sale.paid', { sale, generated });
  };

  client.once(Events.ClientReady, () => console.log(`[DISCORD] Online como ${client.user.tag}`));
  client.on('interactionCreate', async interaction => {
    try {
      if (interaction.isChatInputCommand()) {
        const adminRequired = interaction.commandName !== 'consultarpagamento';
        if (adminRequired && allowed.size > 0 && !isAdmin(interaction.user.id, allowed)) return interaction.reply({ content: 'Sem permissão.', flags: MessageFlags.Ephemeral });
        if (interaction.commandName === 'painelvendas') return interaction.reply({ embeds: [salesPanelEmbed(payments.plans, logoUrl)], components: salesButtons(payments.plans) });
        if (interaction.commandName === 'paineladmin') return interaction.reply({ embeds: [adminPanelEmbed(logoUrl)], components: adminButtons(), flags: MessageFlags.Ephemeral });
        if (interaction.commandName === 'gerarkey') {
          const target = interaction.options.getUser('usuario');
          const result = await service.create({ customer: interaction.options.getString('cliente'), days: interaction.options.getInteger('dias'), discordUserId: target?.id || '', discordUsername: target?.tag || '', source: 'discord-admin' });
          return interaction.reply({ content: `✅ Key: \`${result.key}\`\nID: \`${result.license.id}\`\nVence: <t:${unix(result.license.expiresAt)}:F>`, flags: MessageFlags.Ephemeral });
        }
        if (interaction.commandName === 'infokey') return replyInfo(interaction, store.getById(interaction.options.getString('id')));
        if (interaction.commandName === 'listarkeys') return replyList(interaction, store.list());
        if (interaction.commandName === 'gerarcupom') {
          const days = interaction.options.getInteger('dias');
          const expiresAt = days ? new Date(Date.now() + days * 86400000).toISOString() : null;
          const coupon = await store.createCoupon({ code: interaction.options.getString('codigo'), discountPercent: interaction.options.getInteger('desconto'), maxUses: interaction.options.getInteger('usos'), expiresAt, createdBy: interaction.user.id });
          await store.audit('coupon.created', { couponId: coupon.id, code: coupon.code, discountPercent: coupon.discountPercent, maxUses: coupon.maxUses, adminId: interaction.user.id });
          const validity = coupon.expiresAt ? `\nVence: <t:${unix(coupon.expiresAt)}:F>` : '\nValidade: sem vencimento';
          return interaction.reply({ content: `✅ Cupom criado: \`${coupon.code}\`\nDesconto: **${coupon.discountPercent}%**\nUsos: **${coupon.maxUses}**${validity}`, flags: MessageFlags.Ephemeral });
        }
        if (interaction.commandName === 'listarcupons') return replyCoupons(interaction, store.listCoupons());
        if (interaction.commandName === 'excluircupom') return simpleResult(interaction, await store.removeCoupon(interaction.options.getString('codigo')));
        if (interaction.commandName === 'renovarkey') return simpleResult(interaction, await service.renew(interaction.options.getString('id'), interaction.options.getInteger('dias')));
        if (interaction.commandName === 'bloquekey') return simpleResult(interaction, await service.setStatus(interaction.options.getString('id'), 'blocked'));
        if (interaction.commandName === 'desbloquekey') return simpleResult(interaction, await service.setStatus(interaction.options.getString('id'), 'active'));
        if (interaction.commandName === 'resetarhwid') return simpleResult(interaction, await service.resetHwid(interaction.options.getString('id')));
        if (interaction.commandName === 'excluirkey') return simpleResult(interaction, await service.remove(interaction.options.getString('id')));
        if (interaction.commandName === 'banirhwid') return simpleResult(interaction, await store.banHwid(interaction.options.getString('hwid'), interaction.options.getString('motivo') || '', interaction.user.id));
        if (interaction.commandName === 'desbanirhwid') return simpleResult(interaction, await store.unbanHwid(interaction.options.getString('hwid')));
        if (interaction.commandName === 'consultarpagamento') {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          const result = await payments.confirmTxid(interaction.options.getString('txid'));
          return interaction.editReply(result.ok ? '✅ Pagamento confirmado e key processada.' : `⏳ ${result.reason}`);
        }
      }

      if (interaction.isButton()) {
        if (interaction.customId.startsWith('buy:')) {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          const sale = await payments.createSale({ planId: interaction.customId.split(':')[1], discordUserId: interaction.user.id, discordUsername: interaction.user.tag });
          const attachment = sale.imageData?.startsWith('data:image') ? new AttachmentBuilder(Buffer.from(sale.imageData.split(',')[1], 'base64'), { name: 'pix.png' }) : null;
          const embed = new EmbedBuilder().setTitle('💳 Pagamento Pix — Efí').setColor(0x8b2cf5).addFields(
            { name: 'Plano', value: sale.planName, inline: true }, { name: 'Valor', value: `R$ ${Number(sale.amount).toFixed(2).replace('.', ',')}`, inline: true },
            ...(sale.couponCode ? [{ name: 'Cupom aplicado', value: `\`${sale.couponCode}\` (-${sale.discountPercent}%)`, inline: true }] : []),
            { name: 'Validade', value: `<t:${unix(sale.expiresAt)}:R>` }, { name: 'Copia e cola', value: `\`${truncate(sale.copyPaste, 950)}\`` }, { name: 'TXID', value: `\`${sale.txid}\`` }
          ).setFooter({ text: 'A key será enviada automaticamente após a confirmação.' });
          if (attachment) embed.setImage('attachment://pix.png');
          return interaction.editReply({ embeds: [embed], files: attachment ? [attachment] : [] });
        }
        if (interaction.customId === 'sale:coupon') return interaction.showModal(makeModal('modal:coupon', 'Usar cupom', [{ id: 'code', label: 'Código do cupom', placeholder: 'Ex.: 1533OFF' }]));
        if (interaction.customId === 'sale:check') return interaction.showModal(makeModal('modal:salecheck', 'Consultar pagamento', [{ id: 'txid', label: 'TXID', placeholder: 'Cole o TXID da cobrança' }]));
        if (interaction.customId === 'sale:support') return interaction.reply({ content: supportUrl ? `Suporte: ${supportUrl}` : 'Procure um administrador do servidor.', flags: MessageFlags.Ephemeral });
        if (interaction.customId.startsWith('admin:')) {
          if (allowed.size > 0 && !isAdmin(interaction.user.id, allowed)) return interaction.reply({ content: 'Sem permissão.', flags: MessageFlags.Ephemeral });
          const action = interaction.customId.split(':')[1];
          if (action === 'list') return replyList(interaction, store.list());
          const configs = {
            create: ['modal:create', 'Gerar key', [{ id: 'customer', label: 'Cliente' }, { id: 'days', label: 'Dias', placeholder: '30' }, { id: 'discordid', label: 'ID Discord (opcional)', required: false }]],
            lookup: ['modal:lookup', 'Consultar licença', [{ id: 'id', label: 'ID da licença' }]],
            renew: ['modal:renew', 'Renovar licença', [{ id: 'id', label: 'ID da licença' }, { id: 'days', label: 'Dias adicionais', placeholder: '30' }]],
            reset: ['modal:reset', 'Resetar HWID', [{ id: 'id', label: 'ID da licença' }]],
            block: ['modal:block', 'Bloquear/desbloquear', [{ id: 'id', label: 'ID da licença' }, { id: 'status', label: 'Status: active ou blocked', placeholder: 'blocked' }]],
            delete: ['modal:delete', 'Excluir licença', [{ id: 'id', label: 'ID da licença' }]],
            banhwid: ['modal:banhwid', 'Banir HWID', [{ id: 'hwid', label: 'HWID' }, { id: 'reason', label: 'Motivo', required: false }]],
            unbanhwid: ['modal:unbanhwid', 'Desbanir HWID', [{ id: 'hwid', label: 'HWID' }]],
            coupon: ['modal:admincoupon', 'Gerar cupom', [{ id: 'code', label: 'Código do cupom' }, { id: 'discount', label: 'Desconto em %', placeholder: '10' }, { id: 'uses', label: 'Máximo de usos', placeholder: '1' }, { id: 'days', label: 'Validade em dias (opcional)', required: false }]]
          };
          if (configs[action]) return interaction.showModal(makeModal(...configs[action]));
        }
      }

      if (interaction.isModalSubmit()) {
        if (interaction.customId === 'modal:coupon') {
          const coupon = await store.claimCoupon(interaction.user.id, interaction.fields.getTextInputValue('code'));
          return interaction.reply({ content: `✅ Cupom \`${coupon.code}\` aplicado. O desconto de **${coupon.discountPercent}%** será usado na sua próxima compra.`, flags: MessageFlags.Ephemeral });
        }
        if (interaction.customId === 'modal:salecheck') { await interaction.deferReply({ flags: MessageFlags.Ephemeral }); const r = await payments.confirmTxid(interaction.fields.getTextInputValue('txid')); return interaction.editReply(r.ok ? '✅ Pagamento confirmado.' : `⏳ ${r.reason}`); }
        if (allowed.size > 0 && !isAdmin(interaction.user.id, allowed)) return interaction.reply({ content: 'Sem permissão.', flags: MessageFlags.Ephemeral });
        const id = key => interaction.fields.getTextInputValue(key).trim();
        if (interaction.customId === 'modal:create') { const userId = id('discordid'); const result = await service.create({ customer: id('customer'), days: Number(id('days')), discordUserId: userId, source: 'discord-panel' }); return interaction.reply({ content: `✅ Key: \`${result.key}\`\nID: \`${result.license.id}\``, flags: MessageFlags.Ephemeral }); }
        if (interaction.customId === 'modal:lookup') return replyInfo(interaction, store.getById(id('id')));
        if (interaction.customId === 'modal:renew') return simpleResult(interaction, await service.renew(id('id'), Number(id('days'))));
        if (interaction.customId === 'modal:reset') return simpleResult(interaction, await service.resetHwid(id('id')));
        if (interaction.customId === 'modal:block') return simpleResult(interaction, await service.setStatus(id('id'), id('status').toLowerCase()));
        if (interaction.customId === 'modal:delete') return simpleResult(interaction, await service.remove(id('id')));
        if (interaction.customId === 'modal:banhwid') return simpleResult(interaction, await store.banHwid(id('hwid'), id('reason'), interaction.user.id));
        if (interaction.customId === 'modal:unbanhwid') return simpleResult(interaction, await store.unbanHwid(id('hwid')));
        if (interaction.customId === 'modal:admincoupon') {
          const daysText = id('days');
          const expiresAt = daysText ? new Date(Date.now() + Number(daysText) * 86400000).toISOString() : null;
          const coupon = await store.createCoupon({ code: id('code'), discountPercent: Number(id('discount')), maxUses: Number(id('uses')), expiresAt, createdBy: interaction.user.id });
          await store.audit('coupon.created', { couponId: coupon.id, code: coupon.code, discountPercent: coupon.discountPercent, maxUses: coupon.maxUses, adminId: interaction.user.id });
          return interaction.reply({ content: `✅ Cupom criado: \`${coupon.code}\` — **${coupon.discountPercent}%** de desconto — ${coupon.maxUses} uso(s).`, flags: MessageFlags.Ephemeral });
        }
      }
    } catch (error) {
      console.error('[DISCORD]', error);
      const payload = { content: `❌ ${error.message}`, flags: MessageFlags.Ephemeral };
      if (interaction.deferred || interaction.replied) await interaction.followUp(payload).catch(() => {}); else await interaction.reply(payload).catch(() => {});
    }
  });

  async function replyInfo(interaction, item) {
    if (!item) return interaction.reply({ content: '❌ Licença não encontrada.', flags: MessageFlags.Ephemeral });
    const remaining = Math.max(0, Math.ceil((new Date(item.expiresAt).getTime() - Date.now()) / 86400000));
    return interaction.reply({ embeds: [new EmbedBuilder().setTitle('🔎 Informações da licença').setColor(0x8b2cf5).addFields(
      { name: 'ID', value: `\`${item.id}\`` }, { name: 'Key', value: `\`1533-****-****-****-${item.last4}\`` },
      { name: 'Cliente', value: item.customer || 'Não informado', inline: true }, { name: 'Status', value: item.status, inline: true },
      { name: 'Plano', value: item.plan, inline: true }, { name: 'Dias restantes', value: String(remaining), inline: true },
      { name: 'Vencimento', value: `<t:${unix(item.expiresAt)}:F>` }, { name: 'HWIDs', value: item.hwids?.length ? item.hwids.map(h => `\`${h}\``).join('\n') : 'Nenhum resgate' }
    )], flags: MessageFlags.Ephemeral });
  }
  async function replyList(interaction, items) {
    const text = items.map((item, i) => `${i + 1}. ${item.customer} | ${item.id} | ${item.status} | ${Math.max(0, Math.ceil((new Date(item.expiresAt)-Date.now())/86400000))} dias | 1533-****-${item.last4}`).join('\n') || 'Nenhuma licença.';
    if (text.length <= 1900) return interaction.reply({ content: `\`\`\`txt\n${text}\n\`\`\``, flags: MessageFlags.Ephemeral });
    const file = new AttachmentBuilder(Buffer.from(text, 'utf8'), { name: 'licencas-1533.txt' });
    return interaction.reply({ content: `📋 ${items.length} licenças encontradas.`, files: [file], flags: MessageFlags.Ephemeral });
  }
  async function replyCoupons(interaction, items) {
    const text = items.map((item, i) => `${i + 1}. ${item.code} | ${item.discountPercent}% | ${item.usedCount}/${item.maxUses} usos | ${item.status} | ${item.expiresAt ? new Date(item.expiresAt).toLocaleDateString('pt-BR') : 'sem vencimento'}`).join('\n') || 'Nenhum cupom.';
    if (text.length <= 1900) return interaction.reply({ content: `\`\`\`txt\n${text}\n\`\`\``, flags: MessageFlags.Ephemeral });
    const file = new AttachmentBuilder(Buffer.from(text, 'utf8'), { name: 'cupons-1533.txt' });
    return interaction.reply({ content: `🎟️ ${items.length} cupons encontrados.`, files: [file], flags: MessageFlags.Ephemeral });
  }
  async function simpleResult(interaction, result) { return interaction.reply({ content: result ? '✅ Operação concluída.' : '❌ Registro não encontrado ou dados inválidos.', flags: MessageFlags.Ephemeral }); }

  await client.login(token);
  return { client, logEvent };
}

module.exports = { startDiscordBot };
