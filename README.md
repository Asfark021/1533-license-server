# 1533 License Server

Servidor Node.js com:

- API de ativação e validação de licenças
- painel administrativo web
- bot Discord
- vendas Pix Efí
- cupons, HWID, bloqueios e auditoria

## Execução

```bash
cp .env.example .env
npm install
npm start
```

Teste:

```text
https://SEU-DOMINIO/api/health
```

A resposta deve conter `"ok": true`.

## Hospedagem

Use uma hospedagem web Node.js com domínio HTTPS público. O processo precisa aceitar conexões HTTP e também manter o bot Discord conectado.
