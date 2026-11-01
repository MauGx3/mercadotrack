# MercadoTrack

Rastreio de preços do Mercado Livre no estilo Keepa: histórico acumulado, gráfico
de preços e alertas quando o preço cai.

Feito para quem compra — não para vendedores.

```
┌──────────────────────────────────────────────────────────┐
│  MercadoTrack          ● próxima checagem em 68 min      │
├──────────────┬───────────────────────────────────────────┤
│ adicionar    │  Fone Bluetooth Over-Ear      R$ 415,30    │
│              │  23.5% abaixo da mediana — bom momento    │
│ monitorados  │  ╭─────────────────────────────────────╮  │
│  ▪ item 1    │  │        ╱╲    ╱╲                     │  │
│  ▪ item 2    │  │   ╱╲  ╱  ╲__╱  ╲___                 │  │
│  ▪ item 3    │  │ ╱  ╲╱                            ╲   │  │
│              │  ╰─────────────────────────────────────╯  │
│              │  mínima  máxima  mediana  média  ...      │
└──────────────┴───────────────────────────────────────────┘
```

> Documentação completa (em inglês): [`docs/`](docs/) · README principal:
> [`README.md`](README.md)

## O ponto mais importante

**O Mercado Livre não fornece histórico de preços.** A API oficial devolve o preço
de hoje e nada mais — não existe endpoint de série histórica, e nenhum serviço
público faz esse backfill.

Isso significa que este app **começa a construir o histórico no dia em que você o
instala**. No primeiro dia você tem um ponto. Depois de um mês, um mês de dados.
Não há como contornar isso; é a diferença fundamental entre o Mercado Livre e a
Amazon (cuja série histórica o Keepa comprou e mantém há mais de uma década).

O valor do app cresce com o tempo que ele fica rodando. Rode-o por algumas semanas
antes de confiar nas comparações de "menor preço".

## Instalação

Requer Node.js 22.5+ (usa o `node:sqlite` embutido, sem módulos nativos).

```bash
npm install
npm run setup      # baixa o Chromium do Playwright (ou use o Chrome já instalado)
npm start
```

Abra http://localhost:4747.

Para ver a interface com dados antes de esperar semanas:

```bash
npm run seed              # cria um item de demonstração com 6 meses de histórico
npm run seed -- --clear
```

## Como os dados são obtidos

O app tem duas fontes intercambiáveis. A escolha é automática.

| Fonte | Credenciais | Estabilidade | Velocidade |
|---|---|---|---|
| **browser** (padrão) | nenhuma | média — depende do HTML | ~5–10 s por item |
| **api** (opcional) | app OAuth gratuito | alta | ~0,2 s por item |

### browser (padrão)

Abre a página pública num Chromium real e extrai o preço.

Não é possível usar `fetch` simples: o `mercadolivre.com.br` serve um desafio
anti-bot (proof-of-work) para clientes que não são navegadores. Um navegador real
passa pelo desafio; um `curl` recebe uma página de verificação.

A extração é feita em camadas, da mais estável para a menos estável, para resistir
a mudanças de layout:

1. **JSON-LD** (`schema.org/Product`) — o mais confiável
2. **DOM** com seletores `.andes-money-amount` — o formato visual do ML
3. Fallback de título pela URL, quando nada é legível

### api (opcional)

Mais rápido e estável. Registre um app gratuito em
[developers.mercadolivre.com.br](https://developers.mercadolivre.com.br/), depois:

```bash
export ML_CLIENT_ID=...
export ML_CLIENT_SECRET=...
export ML_ACCESS_TOKEN=...
export MT_SOURCE=api
npm start
```

O token expira em ~6 h; se você fornecer também o `ML_REFRESH_TOKEN`, o app renova
sozinho e grava o novo token no `config.json`.

> Observação: endpoints de busca de itens (`/sites/MLB/search`, `/items`) retornam
> `403 forbidden` sem um app aprovado. A fonte `browser` existe justamente para não
> depender disso.

## Uso

**Adicionar:** cole o link do anúncio no campo da esquerda. Formatos aceitos:

- `https://produto.mercadolivre.com.br/MLB-1234567890-...` (anúncio)
- `https://www.mercadolivre.com.br/.../p/MLB12345678` (catálogo)
- `MLB1234567890` (só o ID)

**Alvos:** defina um preço-alvo, uma queda percentual, ou ambos.

**Gráfico:** alterne entre 7d / 30d / 90d / 1 ano / tudo. Passe o mouse para ver o
preço exato de cada registro. As linhas tracejadas marcam a mínima e a máxima já
observadas.

**Score de oportunidade:** a diferença percentual entre o preço atual e a **mediana**
histórica. Mediana, e não média, porque uma promoção-relâmpago isolada distorce a
média e faria um preço ruim parecer bom.

## Alertas

Quatro regras, cada uma com cooldown próprio por item (padrão: 12 h) para não
transformar uma flutuação em spam:

| Tipo | Dispara quando |
|---|---|
| `new_low` | o preço é o menor já registrado |
| `target` | o preço atinge seu alvo |
| `drop` | cai ao menos X% em relação ao registro anterior |
| `back_in` | o produto estava esgotado e voltou |

Notificações: banner do macOS (`osascript`) e/ou Telegram.

Para receber no celular, crie um bot com o [@BotFather](https://t.me/BotFather) e
configure:

```json
{
  "notify": {
    "telegram": { "enabled": true, "botToken": "123:ABC", "chatId": "987654321" }
  }
}
```

## Linha de comando

```bash
node bin/add.mjs <url> --target 3500 --drop 12
node bin/list.mjs
node bin/check.mjs        # uma passada única; ideal para cron
```

Rodando via cron em vez do servidor:

```cron
0 * * * * cd /caminho/mercadotrack && /usr/bin/env node bin/check.mjs >> data/check.log 2>&1
```

## Configuração

`config.json` (criado a partir dos padrões; variáveis de ambiente têm precedência):

```json
{
  "pollMinutes": 60,
  "jitterMinutes": 10,
  "delayBetweenItems": [4, 9],
  "source": "auto",
  "maxErrorStreak": 8,
  "alertCooldownHours": 12,
  "port": 4747
}
```

- `pollMinutes` — intervalo entre checagens.
- `jitterMinutes` — aleatoriedade somada ao intervalo, para não bater no servidor
  num relógio previsível.
- `delayBetweenItems` — pausa aleatória (segundos) entre itens de uma mesma rodada.
- `maxErrorStreak` — após N falhas seguidas o item é desativado em vez de tentar
  para sempre.

Referência completa de cada chave: [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md).

## Estrutura

```
server.mjs              servidor HTTP + API JSON (sem framework)
lib/db.mjs              SQLite: itens, snapshots, alertas
lib/poller.mjs          ciclo de checagem, backoff, agendamento
lib/alerts.mjs          regras de alerta e cooldown
lib/notify.mjs          banner macOS + Telegram
lib/mltarget.mjs        parsing de URL/ID do Mercado Livre
lib/sources/browser.mjs extração via Chromium (padrão)
lib/sources/api.mjs     API oficial com OAuth (opcional)
public/                 interface: HTML + CSS + JS, sem build
bin/                    CLI: add, list, check, seed
docs/                   documentação técnica
```

## Limitações

- **Sem histórico retroativo.** Ver a primeira seção. É a limitação central.
- **Scraping é frágil por natureza.** Mudanças de layout podem quebrar a extração.
  As camadas de parsing e o fallback de JSON-LD mitigam, mas não eliminam isso.
  Os seletores ainda não foram validados contra o HTML de produção — veja
  [`docs/ROADMAP.md`](docs/ROADMAP.md).
- **Termos de uso.** Scraping pode violar os ToS do Mercado Livre. Para uso sério ou
  comercial, use a fonte `api`. O app pausa entre requisições e evita paralelismo
  justamente para ser um cliente educado.
- **Uso pessoal.** Foi desenhado para dezenas de itens, não milhares.
- Preços de catálogo (`/p/MLB...`) agregam vários vendedores; o preço registrado é o
  da oferta em destaque, que pode mudar de vendedor entre checagens.
