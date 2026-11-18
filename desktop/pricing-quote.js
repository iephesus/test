'use strict';
// One-shot quote before a paid sync starts. Metadata only — never authorizes spend.
const { COMMANDS, ENDPOINTS, MODES } = require('../lib/config');
const { plan } = require('../lib/core');
const { parse } = require('../lib/command-pricing');
const jsonQuery = require('./json-query');
const priceReference = require('./price-reference');

const LABELS = {
  ...MODES,
  'post-details': '补取微博详情（全文）'
};

const PRICE_QUERY = {
  timeoutMs: 12000,
  maxBytes: 2 * 1024 * 1024,
  maxErrorBytes: 400,
  includeStderr: false,
  messages: {
    cancelled: '价格查询已取消',
    timeout: '价格查询超时',
    tooLarge: '价格响应过大',
    failed: '价格查询未成功',
    invalid: '价格响应无法识别'
  }
};

function parseCount(query) {
  if (query.unlimited || String(query.limit || '').trim().toLowerCase() === 'all') return Infinity;
  const n = Number(String(query.limit || '').trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function resolveMode(query) {
  if (COMMANDS[query.mode]) return COMMANDS[query.mode];
  if (Object.values(COMMANDS).includes(query.mode)) return query.mode;
  return null;
}

function quoteParts(query) {
  const mode = resolveMode(query);
  if (!mode) throw Object.assign(Error('无法识别本次获取内容类型'), { code: 'QUOTE_MODE' });
  const count = parseCount(query);
  if (count == null) throw Object.assign(Error('请先填写有效的取数上限，或勾选取完全部'), { code: 'QUOTE_LIMIT' });
  const parts = mode === 'user-posts'
    ? [{ kind: 'user-posts', budget: count }]
    : plan({ mode, count }).filter(p => !Number.isFinite(p.budget) || p.budget > 0);
  if (mode === 'user-posts' && query.fullText) parts.push({ kind: 'post-details', budget: count });
  return { mode, count, parts };
}

function endpointFor(kind) {
  if (kind === 'user-posts') return ['statuses', 'user_timeline/other'];
  if (kind === 'post-details') return ['statuses', 'show_batch/biz'];
  const command = ENDPOINTS[kind]?.command;
  if (!command) throw Object.assign(Error('未知计费方向：' + kind), { code: 'QUOTE_KIND' });
  return command;
}

async function lookupPrice(cli, kind, group, action, signal, queryFn, cached) {
  const hit = cached?.[kind];
  if (hit && Number.isFinite(hit.unitPrice)) return { unitPrice: hit.unitPrice, priceType: hit.priceType || 'per_record' };
  const raw = await queryFn(['commands', 'show', group, action, '--output', 'json'], signal);
  const parsed = parse(raw, { group, action, types: ['per_record', 'per_call'] });
  if (!parsed) return { unitPrice: null, priceType: '' };
  return { unitPrice: parsed.unitPrice, priceType: parsed.priceType };
}

async function quote(query, {
  cli,
  workspace,
  signal,
  query: queryFn = (args, sig) => jsonQuery.invoke(cli, args, sig, PRICE_QUERY)
} = {}) {
  const { mode, count, parts } = quoteParts(query);
  const cached = workspace
    ? Object.fromEntries(priceReference.snapshot(workspace).rows.map(row => [row.id, row]))
    : null;
  const lines = [];
  let estimateMax = 0;
  let unknown = false;
  const unbounded = !Number.isFinite(count) || parts.some(p => !Number.isFinite(p.budget));

  for (const part of parts) {
    const [group, action] = endpointFor(part.kind);
    let unitPrice = null, priceType = '';
    try {
      ({ unitPrice, priceType } = await lookupPrice(cli, part.kind, group, action, signal, queryFn, cached));
    } catch (error) {
      if (signal?.aborted) throw error;
      unknown = true;
    }
    const budget = part.budget;
    const lineEstimate = unitPrice == null || !Number.isFinite(budget)
      ? null
      : Number((unitPrice * budget).toFixed(6));
    if (lineEstimate == null) unknown = true;
    else estimateMax += lineEstimate;
    lines.push({
      kind: part.kind,
      label: LABELS[part.kind] || part.kind,
      group,
      action,
      budget: Number.isFinite(budget) ? budget : null,
      unitPrice,
      priceType,
      estimateMax: lineEstimate
    });
  }

  const result = {
    mode,
    modeLabel: LABELS[mode] || mode,
    unlimited: unbounded,
    count: Number.isFinite(count) ? count : null,
    lines,
    estimateMax: unbounded || unknown ? null : Number(estimateMax.toFixed(6)),
    unknown,
    note: unbounded
      ? '已选择取完全部或未设有限条数，费用可能持续累计，可随时停止。'
      : '预估按「单价 × 各方向取数上限」计算上限；实际按接口新返回条数计费，缓存复用通常不计。以服务端扣费为准。'
  };
  result.message = formatMessage(result);
  return result;
}

function formatMessage(quote, targetLabel) {
  const rows = quote.lines.map(line => {
    const budget = line.budget == null ? '不限' : String(line.budget);
    const unit = line.unitPrice == null
      ? '单价待核实'
      : (line.unitPrice + ' credits / ' + (line.priceType === 'per_call' ? '次请求' : '条返回'));
    const est = line.estimateMax == null ? '预估待核实' : ('上限约 ' + line.estimateMax + ' credits');
    return '· ' + line.label + '（最多 ' + budget + '）\n  ' + line.group + ' ' + line.action + '\n  ' + unit + ' · ' + est;
  });
  const total = quote.estimateMax == null
    ? (quote.unlimited ? '预估总额：无法预先封顶（可能持续计费）' : '预估总额：待核实（请确认是否仍要开始）')
    : ('预估上限合计：约 ' + quote.estimateMax + ' credits');
  return [
    '目标：' + (targetLabel || '当前对象'),
    '内容：' + quote.modeLabel,
    '',
    ...rows,
    '',
    total,
    quote.note,
    '',
    '确认后才会开始联网取数。'
  ].join('\n');
}

module.exports = { quote, quoteParts, formatMessage, parseCount };
