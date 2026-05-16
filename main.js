/* ============================================================================
 * MailDump v0.0.1
 * First public compliance build.
 *
 * Desktop-only Obsidian plugin for exporting IMAP mail into analysis-ready
 * Markdown digests, optional mail notes and adjacent attachments.
 * ========================================================================== */

const { Plugin, PluginSettingTab, Setting, ItemView, Notice } = require('obsidian');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { TextDecoder } = require('util');

const VIEW_TYPE = 'maildump-panel';
const PLUGIN_ID = 'maildump';
const RUN_LOG_FILE = '_mail_dump_runs.json';

const DEFAULT_SETTINGS = {
  imapHost: 'imap.yandex.ru',
  imapPort: 993,
  username: '',
  appPassword: '',
  appPasswordMode: 'store',
  outputFolder: 'MailDump',
  connectTimeoutMs: 60000,
  commandTimeoutMs: 60000,
  maxMessagesWarning: 300,
  fetchBatchSize: 10,
  messageHistoryLimit: 120,
  userAliases: '',
  keyContactEmail: '',
  unansweredThresholdHours: 7,
  tlsRejectUnauthorized: false
};

const PERIOD_OPTIONS = [
  ['today', 'Сегодня'],
  ['yesterday', 'Вчера'],
  ['work_week', 'Рабочая неделя'],
  ['last_7_days', 'Последние 7 дней'],
  ['last_30_days', 'Последние 30 дней'],
  ['custom', 'Произвольный период']
];

const SORT_OPTIONS = [
  ['date', 'Дата'],
  ['subject', 'Тема'],
  ['from', 'Отправитель'],
  ['folder', 'Папка']
];

const DEFAULT_PRESETS = [
  ['preset_mail_yesterday', '📧', 'Почта за вчера', 'yesterday', ['INBOX', 'Sent'], 'Выгрузки писем'],
  ['preset_mail_today', '📧', 'Почта за сегодня', 'today', ['INBOX', 'Sent'], 'Выгрузки писем'],
  ['preset_mail_work_week', '📧', 'Почта за рабочую неделю', 'work_week', ['INBOX', 'Sent'], 'Выгрузки писем'],
  ['preset_mail_last_7_days', '📧', 'Почта за последние 7 дней', 'last_7_days', ['INBOX', 'Sent'], 'Выгрузки писем'],
  ['preset_postmits_last_7_days', '📬', 'Постмиты за 7 дней', 'last_7_days', ['Postmits'], 'Postmits']
];

function waitTick() { return new Promise(resolve => setTimeout(resolve, 0)); }
function chunkArray(arr, size) { const out = []; const step = Math.max(1, Number(size || 1)); for (let i = 0; i < (arr || []).length; i += step) out.push((arr || []).slice(i, i + step)); return out; }
function nowIsoSafe() { return new Date().toISOString().replace(/[:.]/g, '-'); }
function sha1(value) { return crypto.createHash('sha1').update(String(value || '')).digest('hex'); }
function hmac8(salt, value) { return crypto.createHmac('sha256', salt).update(String(value || '')).digest('hex').slice(0, 8); }
function ensureFolder(folderPath) { if (!fs.existsSync(folderPath)) fs.mkdirSync(folderPath, { recursive: true }); }
function fileExists(p) { try { return fs.existsSync(p); } catch { return false; } }
function readJsonFile(filePath, fallback) { try { return fileExists(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : fallback; } catch { return fallback; } }
function writeJsonFile(filePath, value) { ensureFolder(path.dirname(filePath)); fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8'); }
function toRel(basePath, abs) { return path.relative(basePath, abs).replace(/\\/g, '/'); }
function relToAbs(basePath, relOrAbs) { return path.isAbsolute(relOrAbs) ? relOrAbs : path.join(basePath, relOrAbs); }
function sanitizeFileName(name) {
  let s = String(name || 'untitled').replace(/[<>:"/\\|?*]/g, '_').trim().replace(/[. ]+$/g, '');
  if (!s) s = 'untitled';
  return s.slice(0, 160);
}
function uniqueFileName(folderAbs, filename) {
  const parsed = path.parse(filename);
  let candidate = filename;
  let i = 2;
  while (fileExists(path.join(folderAbs, candidate))) {
    candidate = `${parsed.name}_${i}${parsed.ext}`;
    i += 1;
  }
  return candidate;
}
function escapeMdInline(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r?\n/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
function escapeMdBlock(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}
function formatDateFolder(date) {
  const d = Number.isFinite(date.getTime()) ? date : new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function formatDateTime(date) {
  const d = Number.isFinite(date.getTime()) ? date : new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function parseEmailDate(raw) {
  const d = new Date(raw || '');
  return Number.isNaN(d.getTime()) ? new Date() : d;
}
function formatPeriodLabel(fromDate, toDate) {
  const a = formatDateFolder(fromDate);
  const b = formatDateFolder(toDate);
  return a === b ? a : `${a}→${b}`;
}
function quoteImap(value) { return '"' + String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'; }
function splitTerms(raw) { return String(raw || '').split(/[;,\n]/).map(x => x.trim()).filter(Boolean); }
function normalizeExt(value) {
  const s = String(value || '').trim().toLowerCase().replace(/^\./, '');
  return s;
}
function splitExtTerms(raw) {
  return String(raw || '').split(/[;,\s]+/).map(normalizeExt).filter(Boolean);
}
function getEnabledAttachmentExts(preset) {
  const artifacts = preset?.artifacts || {};
  const base = Array.isArray(artifacts.attachmentExtensions) ? artifacts.attachmentExtensions : ['txt', 'pdf'];
  const custom = splitExtTerms(artifacts.customAttachmentExtensions || '');
  return Array.from(new Set([...base.map(normalizeExt), ...custom].filter(Boolean)));
}
function attachmentAllowed(filename, preset) {
  const exts = getEnabledAttachmentExts(preset);
  if (!exts.length) return false;
  if (exts.includes('*')) return true;
  const ext = normalizeExt(path.extname(String(filename || '')).replace(/^\./, ''));
  return !!ext && exts.includes(ext);
}
function formatFileTimePrefix(date, uid) {
  const d = Number.isFinite(date.getTime()) ? date : new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}_${String(uid || '').replace(/\W+/g, '')}`;
}
function getWeekFolderName(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = d.getDay();
  const diff = day === 0 ? 6 : day - 1;
  const start = new Date(d); start.setDate(d.getDate() - diff);
  const end = new Date(start); end.setDate(start.getDate() + 6);
  return `${formatDateFolder(start)} → ${formatDateFolder(end)}`;
}
function getGroupingFolderName(date, grouping) {
  if (grouping === 'day') return formatDateFolder(date);
  if (grouping === 'week') return getWeekFolderName(date);
  if (grouping === 'month') return formatDateFolder(date).slice(0, 7);
  return '';
}
function normalizeBool(value, fallback) { return value === undefined ? !!fallback : !!value; }
function normalizeCompare(value) { return String(value || '').toLowerCase().replace(/ё/g, 'е'); }
function containsAllNeedles(source, needlesRaw) {
  const needles = splitTerms(needlesRaw).map(normalizeCompare);
  if (!needles.length) return true;
  const s = normalizeCompare(source);
  return needles.every(n => s.includes(n));
}
function containsAnyNeedles(source, needlesRaw) {
  const needles = splitTerms(needlesRaw).map(normalizeCompare);
  if (!needles.length) return false;
  const s = normalizeCompare(source);
  return needles.some(n => s.includes(n));
}
function extractEmails(value) {
  const out = [];
  const re = /[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}/gi;
  let m;
  while ((m = re.exec(String(value || '')))) out.push(m[0].toLowerCase());
  return Array.from(new Set(out));
}
function decodeEntity(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}
function stripHtml(html) {
  return decodeEntity(String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<!--([\s\S]*?)-->/g, ' ')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n\n')
    .replace(/<\/div\s*>/gi, '\n')
    .replace(/<\/li\s*>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
function normalizeSubject(subject) {
  let s = String(subject || '');
  // Unicode-нормализация (NFKC схлопывает совместимые формы).
  try { s = s.normalize('NFKC'); } catch {}
  // Keycap-эмодзи: DIGIT + VS16 (FE0F) + COMBINING ENCLOSING KEYCAP (20E3) → голая цифра.
  s = s.replace(/([0-9#*])\uFE0F?\u20E3/g, '$1');
  // Variation selectors и zero-width characters удаляем.
  s = s.replace(/[\uFE0E\uFE0F\u200B\u200C\u200D\u2060\uFEFF]/g, '');
  // Non-breaking и узкие пробелы → обычный пробел.
  s = s.replace(/[\u00A0\u2007\u202F\u2009\u200A]/g, ' ');
  return s
    .replace(/^\s*((re|fw|fwd|ответ|пер|пересл)\s*[:：])+\s*/i, '')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}
function isSentMailbox(mailbox) {
  return /(^|[/\\])(sent|sent messages|отправленные|исходящие)([/\\]|$)/i.test(String(mailbox || ''));
}
function resolveDateRange(preset) {
  const mode = preset?.period?.mode || 'last_7_days';
  const now = new Date();
  const startOfDay = d => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
  const endOfDay = d => { const x = new Date(d); x.setHours(23, 59, 59, 999); return x; };
  if (mode === 'today') return { from: startOfDay(now), to: endOfDay(now) };
  if (mode === 'yesterday') { const y = new Date(now); y.setDate(now.getDate() - 1); return { from: startOfDay(y), to: endOfDay(y) }; }
  if (mode === 'work_week') {
    const d = startOfDay(now);
    const day = d.getDay();
    const diffToMonday = day === 0 ? 6 : day - 1;
    const monday = new Date(d); monday.setDate(d.getDate() - diffToMonday);
    const friday = new Date(monday); friday.setDate(monday.getDate() + 4);
    return { from: startOfDay(monday), to: endOfDay(friday) };
  }
  if (mode === 'last_30_days') { const f = new Date(now); f.setDate(now.getDate() - 29); return { from: startOfDay(f), to: endOfDay(now) }; }
  if (mode === 'custom') {
    const f = preset?.period?.from ? new Date(String(preset.period.from).slice(0, 10) + 'T00:00:00') : now;
    const t = preset?.period?.to ? new Date(String(preset.period.to).slice(0, 10) + 'T00:00:00') : now;
    return { from: startOfDay(f), to: endOfDay(t) };
  }
  const f = new Date(now); f.setDate(now.getDate() - 6);
  return { from: startOfDay(f), to: endOfDay(now) };
}
function buildDateCriteria(fromDate, toDate) {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const fmt = d => `${String(d.getDate()).padStart(2, '0')}-${months[d.getMonth()]}-${d.getFullYear()}`;
  const toExclusive = new Date(toDate.getTime());
  toExclusive.setDate(toExclusive.getDate() + 1);
  return `SINCE ${fmt(fromDate)} BEFORE ${fmt(toExclusive)}`;
}
function createPreset(id, emoji, name, mode, mailboxes, subfolder) {
  const isPostmits = /postmit|постмит/i.test(String(id || '') + ' ' + String(name || '') + ' ' + (Array.isArray(mailboxes) ? mailboxes.join(' ') : ''));
  return {
    schemaVersion: 4,
    id: id || `preset_${Date.now()}_${crypto.randomBytes(2).toString('hex')}`,
    name: name || 'Новый пресет',
    emoji: emoji || '📧',
    period: { mode: mode || 'last_7_days', from: null, to: null },
    source: { mailboxes: Array.isArray(mailboxes) ? mailboxes : [] },
    output: {
      subfolder: isPostmits ? (subfolder || 'Postmits') : '',
      exportName: name || 'Почтовая сводка',
      summaryPrefix: '',
      createEmptyDigest: true,
      grouping: isPostmits ? 'day' : 'none',
      filePrefixMode: 'datetime'
    },
    filters: { include: { from: '', to: '', subject: '' }, exclude: { from: '', to: '', subject: '' } },
    content: {
      stripHistory: true,
      stripSignatures: true,
      keepOriginalBody: false,
      keepForwarded: true,
      replyChainStartMarker: '',
      includeTo: true,
      includeCc: true,
      includeReferences: true,
      includeAttachments: true
    },
    artifacts: {
      saveDigest: true,
      saveMailNotes: !!isPostmits,
      saveAttachments: !!isPostmits,
      attachmentExtensions: isPostmits ? ['txt', 'pdf'] : [],
      customAttachmentExtensions: ''
    },
    performance: { fetchBatchSize: 10 },
    sort: { by: 'date', direction: 'asc' }
  };
}
function defaultPresets() { return DEFAULT_PRESETS.map(x => createPreset(...x)); }
function migratePreset(raw) {
  if (!raw || typeof raw !== 'object') return createPreset();
  const p = createPreset(raw.id, raw.emoji || '📧', raw.name || 'Без названия', raw.period?.mode || raw.dateMode || 'last_7_days', raw.source?.mailboxes || raw.mailboxes || [], raw.output?.subfolder || raw.outputSubfolder || '');
  p.period = { ...p.period, ...(raw.period || {}) };
  p.source = { mailboxes: Array.isArray(raw.source?.mailboxes) ? raw.source.mailboxes : p.source.mailboxes };
  const rawOutput = raw.output || {};
  p.output = {
    subfolder: (rawOutput.subfolder !== undefined && String(rawOutput.subfolder).trim()) ? rawOutput.subfolder : p.output.subfolder,
    exportName: rawOutput.exportName || raw.name || p.output.exportName,
    summaryPrefix: rawOutput.summaryPrefix || '',
    createEmptyDigest: rawOutput.createEmptyDigest !== false,
    grouping: rawOutput.grouping || p.output.grouping || 'none',
    filePrefixMode: rawOutput.filePrefixMode || p.output.filePrefixMode || 'datetime'
  };
  p.filters = {
    include: {
      from: raw.filters?.include?.from || raw.fromFilter || '',
      to: raw.filters?.include?.to || raw.toFilter || '',
      subject: raw.filters?.include?.subject || raw.subjectFilter || ''
    },
    exclude: {
      from: raw.filters?.exclude?.from || '',
      to: raw.filters?.exclude?.to || '',
      subject: raw.filters?.exclude?.subject || ''
    }
  };
  p.content = {
    stripHistory: raw.content?.stripHistory !== undefined ? !!raw.content.stripHistory : raw.content?.stripQuotedText !== false,
    stripSignatures: raw.content?.stripSignatures !== false,
    keepOriginalBody: !!raw.content?.keepOriginalBody || raw.content?.stripQuotedText === false,
    keepForwarded: raw.content?.keepForwarded !== false,
    replyChainStartMarker: raw.content?.replyChainStartMarker || raw.content?.chainStartMarker || '',
    includeTo: raw.content?.includeTo !== false,
    includeCc: raw.content?.includeCc !== false,
    includeReferences: raw.content?.includeReferences !== false,
    includeAttachments: raw.content?.includeAttachments !== false
  };
  p.artifacts = {
    saveDigest: raw.artifacts?.saveDigest !== false,
    saveMailNotes: normalizeBool(raw.artifacts?.saveMailNotes, p.artifacts.saveMailNotes),
    saveAttachments: normalizeBool(raw.artifacts?.saveAttachments, p.artifacts.saveAttachments),
    attachmentExtensions: Array.isArray(raw.artifacts?.attachmentExtensions) ? raw.artifacts.attachmentExtensions.map(normalizeExt).filter(Boolean) : p.artifacts.attachmentExtensions,
    customAttachmentExtensions: raw.artifacts?.customAttachmentExtensions || ''
  };
  p.performance = { fetchBatchSize: Number(raw.performance?.fetchBatchSize || raw.fetchBatchSize || p.performance.fetchBatchSize || 10) };
  p.sort = { by: raw.sort?.by || 'date', direction: raw.sort?.direction === 'desc' ? 'desc' : 'asc' };
  return p;
}
function sortRecords(records, preset) {
  const by = preset?.sort?.by || 'date';
  const dir = preset?.sort?.direction === 'desc' ? -1 : 1;
  return records.slice().sort((a, b) => {
    let av; let bv;
    if (by === 'subject') { av = a.subject || ''; bv = b.subject || ''; }
    else if (by === 'from') { av = a.from || ''; bv = b.from || ''; }
    else if (by === 'folder') { av = a.mailbox || ''; bv = b.mailbox || ''; }
    else { av = a.dateObj ? a.dateObj.getTime() : 0; bv = b.dateObj ? b.dateObj.getTime() : 0; }
    if (typeof av === 'number') return (av - bv) * dir;
    return String(av).localeCompare(String(bv), 'ru') * dir;
  });
}

function decodeBytes(buffer, charset) {
  const cs = String(charset || 'utf-8').trim().toLowerCase().replace(/^"|"$/g, '');
  try {
    if (cs && cs !== 'utf8') return new TextDecoder(cs).decode(buffer);
    return new TextDecoder('utf-8').decode(buffer);
  } catch {
    try { return new TextDecoder('windows-1251').decode(buffer); } catch { return Buffer.from(buffer).toString('utf8'); }
  }
}
function qpToBytes(input) {
  const latin = Buffer.isBuffer(input) ? input.toString('latin1') : String(input || '');
  const cleaned = latin.replace(/=\r?\n/g, '');
  const out = [];
  for (let i = 0; i < cleaned.length; i++) {
    if (cleaned[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(cleaned.slice(i + 1, i + 3))) {
      out.push(parseInt(cleaned.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      out.push(cleaned.charCodeAt(i) & 0xff);
    }
  }
  return Buffer.from(out);
}
function decodeTransfer(bodyBuffer, encoding) {
  const enc = String(encoding || '').trim().toLowerCase();
  if (enc === 'base64') {
    const s = bodyBuffer.toString('ascii').replace(/\s+/g, '');
    try { return Buffer.from(s, 'base64'); } catch { return bodyBuffer; }
  }
  if (enc === 'quoted-printable') return qpToBytes(bodyBuffer);
  return bodyBuffer;
}
function decodeMimeWords(value) {
  // RFC 2047 §6.2: linear-white-space между смежными encoded-words игнорируется при отображении.
  // Без этого Yandex/Outlook subject вида "=?UTF-8?B?...?=\r\n =?UTF-8?B?...?=" даёт "Алтуфьев ское".
  const stitched = String(value || '').replace(/\?=\s+=\?/g, '?==?');
  return stitched.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_, charset, enc, text) => {
    try {
      let bytes;
      if (enc.toUpperCase() === 'B') bytes = Buffer.from(text, 'base64');
      else bytes = qpToBytes(String(text).replace(/_/g, ' '));
      return decodeBytes(bytes, charset);
    } catch { return text; }
  }).replace(/\s{2,}/g, ' ').trim();
}
function parseHeadersFromLatin(headerLatin) {
  const lines = String(headerLatin || '').replace(/\r/g, '').split('\n');
  const headers = {};
  const raw = [];
  let current = null;
  for (const line of lines) {
    if (!line) continue;
    raw.push(line);
    if (/^[ \t]/.test(line) && current) {
      headers[current] += ' ' + line.trim();
      continue;
    }
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    current = line.slice(0, idx).trim().toLowerCase();
    headers[current] = line.slice(idx + 1).trim();
  }
  return { headers, rawHeaders: raw.join('\n') };
}
function splitHeaderBodyBuffer(buf) {
  const latin = buf.toString('latin1');
  let idx = latin.indexOf('\r\n\r\n');
  let markerLen = 4;
  if (idx === -1) { idx = latin.indexOf('\n\n'); markerLen = 2; }
  if (idx === -1) return { headerLatin: latin, bodyBuffer: Buffer.alloc(0) };
  return { headerLatin: latin.slice(0, idx), bodyBuffer: buf.slice(idx + markerLen) };
}
function parseParamHeader(value) {
  const raw = String(value || '');
  const parts = raw.split(';');
  const main = (parts.shift() || '').trim().toLowerCase();
  const params = {};
  for (const p of parts) {
    const idx = p.indexOf('=');
    if (idx === -1) continue;
    const key = p.slice(0, idx).trim().toLowerCase();
    let val = p.slice(idx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    params[key] = decodeMimeWords(val);
  }
  return { main, params };
}
function splitMultipart(bodyBuffer, boundary) {
  if (!boundary) return [];
  const latin = bodyBuffer.toString('latin1');
  const marker = '--' + boundary;
  const out = [];
  let pos = latin.indexOf(marker);
  if (pos === -1) return [];
  while (pos !== -1) {
    pos += marker.length;
    if (latin.slice(pos, pos + 2) === '--') break;
    if (latin.slice(pos, pos + 2) === '\r\n') pos += 2;
    else if (latin[pos] === '\n') pos += 1;
    let next = latin.indexOf('\r\n' + marker, pos);
    let prefix = 2;
    if (next === -1) { next = latin.indexOf('\n' + marker, pos); prefix = 1; }
    if (next === -1) break;
    out.push(bodyBuffer.slice(pos, next));
    pos = next + prefix;
  }
  return out;
}
function decodeFilename(value) {
  let v = decodeMimeWords(value || 'attachment.bin');
  try { v = decodeURIComponent(v); } catch {}
  return sanitizeFileName(v || 'attachment.bin');
}
function walkMimePart(partBuffer, out) {
  const { headerLatin, bodyBuffer } = splitHeaderBodyBuffer(partBuffer);
  const { headers } = parseHeadersFromLatin(headerLatin);
  const ctype = parseParamHeader(headers['content-type'] || 'text/plain; charset=utf-8');
  const dispo = parseParamHeader(headers['content-disposition'] || '');
  const encoding = headers['content-transfer-encoding'] || '';

  if (ctype.main.startsWith('multipart/')) {
    const parts = splitMultipart(bodyBuffer, ctype.params.boundary);
    for (const child of parts) walkMimePart(child, out);
    return;
  }

  const filename = dispo.params.filename || dispo.params['filename*'] || ctype.params.name || ctype.params['name*'] || '';
  const isAttachment = !!filename || dispo.main === 'attachment';
  if (isAttachment) {
    out.attachments.push({ filename: decodeFilename(filename || 'attachment.bin'), contentType: ctype.main || 'application/octet-stream' });
    return;
  }

  const decodedBytes = decodeTransfer(bodyBuffer, encoding);
  const charset = ctype.params.charset || 'utf-8';
  const decodedText = decodeBytes(decodedBytes, charset);
  if (ctype.main === 'text/html') out.htmlParts.push(decodedText);
  else if (ctype.main === 'text/plain' || ctype.main === '') out.textParts.push(decodedText);
}
function parseRawEmail(rawBuffer) {
  const { headerLatin, bodyBuffer } = splitHeaderBodyBuffer(rawBuffer || Buffer.alloc(0));
  const { headers, rawHeaders } = parseHeadersFromLatin(headerLatin);
  const ctype = parseParamHeader(headers['content-type'] || 'text/plain; charset=utf-8');
  const out = { textParts: [], htmlParts: [], attachments: [] };
  if (ctype.main.startsWith('multipart/')) {
    for (const part of splitMultipart(bodyBuffer, ctype.params.boundary)) walkMimePart(part, out);
  } else {
    walkMimePart(rawBuffer, out);
  }
  const text = out.textParts.join('\n\n').trim();
  const html = out.htmlParts.join('\n\n').trim();
  const bodyText = (text || stripHtml(html) || '').trim();
  return {
    subject: decodeMimeWords(headers.subject || ''),
    from: decodeMimeWords(headers.from || ''),
    to: decodeMimeWords(headers.to || ''),
    cc: decodeMimeWords(headers.cc || ''),
    bcc: decodeMimeWords(headers.bcc || ''),
    date: headers.date || '',
    messageId: (headers['message-id'] || '').trim(),
    inReplyTo: (headers['in-reply-to'] || '').trim(),
    references: (headers.references || '').trim(),
    text,
    html,
    bodyText,
    attachments: out.attachments,
    headers,
    rawHeaders
  };
}
function isForwardMarkerLine(line) {
  return /(^|\s)(forwarded message|пересылаемое сообщение|перенаправленное сообщение|begin forwarded message|начало пересылаемого сообщения)/i.test(String(line || ''))
    || /^[-_]{2,}\s*(Forwarded message|Пересылаемое сообщение|Перенаправленное сообщение)\s*[-_]{2,}$/i.test(String(line || '').trim());
}
function isReplyMarkerLine(line) {
  const l = String(line || '').trim();
  if (!l) return false;
  return /^[-_]{2,}\s*(Original Message|Исходное сообщение|Оригинальное сообщение)\s*[-_]{2,}$/i.test(l)
    || /^On .{1,240}wrote:\s*$/i.test(l)
    || /^.+\s+(wrote|написал\(а\)|пишет):\s*$/i.test(l)
    || /^В .*пользователь .*написал/i.test(l);
}


function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function flexibleMarkerPattern(marker) {
  let out = '';
  let inSpace = false;
  for (const ch of String(marker || '')) {
    if (/\s/.test(ch)) {
      if (!inSpace) out += '\\s+';
      inSpace = true;
      continue;
    }
    inSpace = false;
    out += escapeRegExp(ch);
  }
  return out;
}
function findManualReplyChainMarkerIndex(text, markerRaw) {
  const source = String(text || '').replace(/\r/g, '');
  let marker = String(markerRaw || '').replace(/\r/g, '').replace(/\\n/g, '\n').trim();
  if (marker.length < 3) return -1;

  let idx = source.indexOf(marker);
  if (idx !== -1) return idx;

  try {
    const re = new RegExp(flexibleMarkerPattern(marker), 'i');
    const m = re.exec(source);
    return m ? m.index : -1;
  } catch {
    return -1;
  }
}
function looksLikeReplyHeaderBlock(lines, i) {
  const window = lines.slice(i, i + 8).map(x => String(x || '').trim()).filter(Boolean);
  if (!window.length) return false;
  let hits = 0;
  for (const l of window) {
    if (/^(From|От):\s*.*$/i.test(l)) hits += 1;
    if (/^(Sent|Отправлено|Date|Дата):\s*.*$/i.test(l)) hits += 1;
    if (/^(To|Кому):\s*.*$/i.test(l)) hits += 1;
    if (/^(Cc|Копия):\s*.*$/i.test(l)) hits += 1;
    if (/^(Subject|Тема):\s*.*$/i.test(l)) hits += 1;
  }
  return hits >= 3;
}
function stripReplyHistory(text, opts = {}) {
  const source = String(text || '').replace(/\r/g, '');
  const manualIdx = findManualReplyChainMarkerIndex(source, opts.replyChainStartMarker || opts.chainStartMarker || '');
  if (manualIdx !== -1) {
    return source.slice(0, manualIdx).split('\n').filter(line => !/^\s*>/.test(line)).join('\n');
  }

  const lines = source.split('\n');
  let cutAt = lines.length;
  let forwardHeaderAllowanceUntil = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (isForwardMarkerLine(line)) {
      if (opts.keepForwarded === false) { cutAt = i; break; }
      // Пересылку сохраняем: следующий служебный блок From/Sent/To/Subject
      // считается частью пересланного письма, а не цепочкой ответа.
      forwardHeaderAllowanceUntil = Math.max(forwardHeaderAllowanceUntil, i + 12);
      continue;
    }

    if (isReplyMarkerLine(line)) {
      cutAt = i;
      break;
    }

    if (looksLikeReplyHeaderBlock(lines, i)) {
      if (i <= forwardHeaderAllowanceUntil) {
        // Это заголовок пересланного сообщения. Сохраняем его и продолжаем,
        // чтобы отрезать только первый ответ уже внутри пересылки.
        continue;
      }
      cutAt = i;
      break;
    }
  }

  let kept = lines.slice(0, cutAt);
  kept = kept.filter(line => !/^\s*>/.test(line));
  return kept.join('\n');
}
function stripSignature(text) {
  return String(text || '')
    .replace(/(?:\n|^)--\s*\n[\s\S]*$/m, '')
    .replace(/\n(С уважением|С наилучшими пожеланиями|Best regards|Regards|Kind regards|Sent from my iPhone|Отправлено с iPhone)[\s\S]*$/i, '');
}
function stripHistoryAndSignatures(text, opts) {
  let s = String(text || '').replace(/\r/g, '').trim();
  if (!s) return '';
  if (opts.stripHistory !== false) s = stripReplyHistory(s, opts);
  if (opts.stripSignatures !== false) s = stripSignature(s);
  return s.replace(/[ \t]+\n/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim();
}


class OperationStore {
  constructor(plugin) {
    this.plugin = plugin;
    this.active = null;
    this.subscribers = new Set();
  }
  start(type, meta = {}) {
    if (this.active) throw new Error(`Уже выполняется операция: ${this.active.type}`);
    this.active = { id: `${type}_${Date.now()}_${crypto.randomBytes(2).toString('hex')}`, type, status: 'running', cancelled: false, ...meta, text: meta.text || '', progress: meta.progress || 0, progressMode: meta.progressMode || 'indeterminate' };
    if (this.plugin && this.plugin.appendMessageHistory) this.plugin.appendMessageHistory(this.active.text || type, this.active);
    this.emit();
    return this.active;
  }
  update(patch = {}) { if (!this.active) return; Object.assign(this.active, patch); if (this.plugin && this.plugin.appendMessageHistory && patch.text) this.plugin.appendMessageHistory(patch.text, this.active); this.emit(); }
  cancel() {
    if (this.active) { this.active.cancelled = true; this.active.status = 'cancelling'; this.active.text = 'Остановка: разрываю активный IMAP-запрос...'; }
    if (this.plugin && this.plugin.appendMessageHistory) this.plugin.appendMessageHistory(this.active ? this.active.text : 'Остановка', this.active);
    this.emit();
    if (this.plugin && typeof this.plugin.abortActiveClient === 'function') this.plugin.abortActiveClient();
  }
  finish(token, status = 'completed') {
    if (!this.active || (token && this.active.id !== token.id)) return;
    this.active.status = status;
    this.active.progressMode = status === 'completed' ? 'percent' : 'hidden';
    this.active.progress = status === 'completed' ? 100 : this.active.progress;
    if (this.plugin && this.plugin.appendMessageHistory) this.plugin.appendMessageHistory(`Операция ${this.active.type}: ${status}`, this.active);
    this.emit();
    setTimeout(() => {
      if (this.active && token && this.active.id === token.id) { this.active = null; this.emit(); }
    }, 700);
  }
  isBusy() { return !!this.active; }
  subscribe(fn) { this.subscribers.add(fn); return () => this.subscribers.delete(fn); }
  emit() { for (const fn of this.subscribers) { try { fn(this.active); } catch {} } }
}

class PresetStore {
  constructor(plugin) {
    this.plugin = plugin;
  }
  load() {
    const raw = Array.isArray(this.plugin.dataCache?.presets) ? this.plugin.dataCache.presets : null;
    const arr = raw || defaultPresets();
    const migrated = arr.map(migratePreset);
    if (!migrated.length) migrated.push(...defaultPresets());
    this.save(migrated);
    return migrated;
  }
  save(presets) {
    this.plugin.dataCache = this.plugin.dataCache || {};
    this.plugin.dataCache.presets = presets || [];
    this.plugin.persistData();
  }
  exportToFile(presets) {
    const basePath = this.plugin.app.vault.adapter.getBasePath();
    const outputAbs = path.join(basePath, this.plugin.settings.outputFolder || 'MailDump');
    ensureFolder(outputAbs);
    const fileName = `maildump-presets-${nowIsoSafe()}.json`;
    const abs = path.join(outputAbs, fileName);
    writeJsonFile(abs, presets || []);
    return toRel(basePath, abs);
  }
  importFromFile(filePath) {
    const basePath = this.plugin.app.vault.adapter.getBasePath();
    const abs = relToAbs(basePath, filePath);
    const raw = readJsonFile(abs, null);
    if (!Array.isArray(raw)) throw new Error('Файл импорта должен содержать JSON-массив пресетов');
    const imported = raw.map(migratePreset);
    if (!imported.length) throw new Error('В файле нет пресетов');
    this.save(imported);
    return imported;
  }
}

class RunLogStore {
  constructor(plugin) { this.plugin = plugin; }
  get basePath() { return this.plugin.app.vault.adapter.getBasePath(); }
  get outputAbs() { return path.join(this.basePath, this.plugin.settings.outputFolder || 'MailDump'); }
  get filePath() { return path.join(this.outputAbs, RUN_LOG_FILE); }
  read() { const v = readJsonFile(this.filePath, []); return Array.isArray(v) ? v : []; }
  append(entry) {
    ensureFolder(this.outputAbs);
    const list = this.read();
    list.push(entry);
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const recent = list.filter(x => Date.parse(x.startedAt || x.finishedAt || '') >= cutoff);
    const tail = list.slice(-200);
    const merged = Array.from(new Map([...recent, ...tail].map(x => [x.runId || `${Math.random()}`, x])).values());
    writeJsonFile(this.filePath, merged);
  }
  clear() {
    ensureFolder(this.outputAbs);
    writeJsonFile(this.filePath, []);
  }
  getLastDigestRun() { return this.read().slice().reverse().find(x => Array.isArray(x.filesCreated) && x.filesCreated.length); }
}


function extractLiterals(buf) {
  const latin = buf.toString('latin1');
  const out = [];
  const re = /\{(\d+)\}\r?\n/g;
  let m;
  while ((m = re.exec(latin)) !== null) {
    const len = Number(m[1] || 0);
    const start = m.index + m[0].length;
    const end = start + len;
    if (end <= buf.length) out.push(buf.slice(start, end));
    re.lastIndex = end;
  }
  return out;
}

function extractBalancedAfter(source, keyword) {
  const lower = source.toLowerCase();
  const keyPos = lower.indexOf(String(keyword || '').toLowerCase());
  if (keyPos === -1) return '';
  let start = source.indexOf('(', keyPos);
  if (start === -1) return '';
  let depth = 0;
  let inQuote = false;
  let esc = false;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (inQuote) {
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') { inQuote = false; continue; }
      continue;
    }
    if (ch === '"') { inQuote = true; continue; }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return '';
}

function parseImapStructuredValue(input) {
  const s = String(input || '');
  let i = 0;
  const skip = () => { while (i < s.length && /\s/.test(s[i])) i += 1; };
  const parseQuoted = () => {
    i += 1;
    let out = '';
    while (i < s.length) {
      const ch = s[i++];
      if (ch === '\\' && i < s.length) { out += s[i++]; continue; }
      if (ch === '"') break;
      out += ch;
    }
    return out;
  };
  const parseAtom = () => {
    const start = i;
    while (i < s.length && !/[\s()]/.test(s[i])) i += 1;
    const atom = s.slice(start, i);
    if (/^NIL$/i.test(atom)) return null;
    return atom;
  };
  const parseList = () => {
    const arr = [];
    i += 1;
    while (i < s.length) {
      skip();
      if (s[i] === ')') { i += 1; break; }
      arr.push(parseValue());
    }
    return arr;
  };
  const parseValue = () => {
    skip();
    if (s[i] === '(') return parseList();
    if (s[i] === '"') return parseQuoted();
    return parseAtom();
  };
  return parseValue();
}

function paramsArrayToObject(value) {
  const out = {};
  if (!Array.isArray(value)) return out;
  for (let i = 0; i < value.length - 1; i += 2) {
    const key = String(value[i] || '').toLowerCase();
    if (!key) continue;
    out[key] = value[i + 1] == null ? '' : String(value[i + 1]);
  }
  return out;
}

function findDispositionInfo(part) {
  if (!Array.isArray(part)) return { name: '', params: {} };
  for (const item of part) {
    if (Array.isArray(item) && typeof item[0] === 'string' && /^(attachment|inline)$/i.test(item[0])) {
      return { name: String(item[0]).toLowerCase(), params: paramsArrayToObject(item[1]) };
    }
  }
  return { name: '', params: {} };
}
function findDispositionName(part) { return findDispositionInfo(part).name; }
function analyzeBodyStructureNode(node, prefix = '') {
  const result = { textParts: [], attachmentParts: [], hasAttachments: false };
  if (!Array.isArray(node) || !node.length) return result;
  const first = node[0];

  if (Array.isArray(first)) {
    let partNo = 1;
    for (const child of node) {
      if (!Array.isArray(child)) break;
      const childId = prefix ? `${prefix}.${partNo}` : String(partNo);
      const childResult = analyzeBodyStructureNode(child, childId);
      result.textParts.push(...childResult.textParts);
      result.attachmentParts.push(...childResult.attachmentParts);
      if (childResult.hasAttachments) result.hasAttachments = true;
      partNo += 1;
    }
    return result;
  }

  const type = String(node[0] || '').toLowerCase();
  const subtype = String(node[1] || '').toLowerCase();
  const params = paramsArrayToObject(node[2]);
  const encoding = String(node[5] || '').toLowerCase();
  const dispo = findDispositionInfo(node);
  const rawFilename = dispo.params.filename || dispo.params.name || params.filename || params.name || '';
  const filename = rawFilename ? decodeFilename(rawFilename) : '';
  const isText = type === 'text' && (subtype === 'plain' || subtype === 'html');
  const isAttachment = dispo.name === 'attachment' || !!filename || !isText;
  if (isAttachment) {
    result.hasAttachments = true;
    if (filename) {
      result.attachmentParts.push({
        partId: prefix || 'TEXT',
        type,
        subtype,
        contentType: `${type || 'application'}/${subtype || 'octet-stream'}`,
        filename,
        encoding
      });
    }
  }
  if (isText && dispo.name !== 'attachment' && !filename) {
    result.textParts.push({
      partId: prefix || 'TEXT',
      type,
      subtype,
      charset: params.charset || 'utf-8',
      encoding
    });
  }
  return result;
}

function analyzeBodyStructure(rawBodyStructure) {
  const parsed = parseImapStructuredValue(rawBodyStructure || '');
  const analyzed = analyzeBodyStructureNode(parsed, '');
  const plain = analyzed.textParts.filter(p => p.subtype === 'plain');
  const html = analyzed.textParts.filter(p => p.subtype === 'html');
  // Забираем и text/plain, и text/html: у части IMAP-серверов реальное тело письма лежит только в HTML-part.
  analyzed.selectedParts = [...plain, ...html];
  return analyzed;
}

function parseFetchMetaResponse(buf, fallbackUid = '') {
  const latin = buf.toString('latin1');
  const uidMatch = /\bUID\s+(\d+)\b/i.exec(latin);
  const flagsMatch = /FLAGS\s+\(([^)]*)\)/i.exec(latin);
  const bodyStructure = extractBalancedAfter(latin, 'BODYSTRUCTURE');
  const literals = extractLiterals(buf);
  return {
    uid: uidMatch ? uidMatch[1] : String(fallbackUid || ''),
    flags: flagsMatch ? flagsMatch[1].trim() : '',
    bodyStructure,
    headerRaw: literals[0] || Buffer.alloc(0)
  };
}

function parseFetchedTextOnlyEmail(fetched) {
  const headerLatin = (fetched.headerRaw || Buffer.alloc(0)).toString('latin1');
  const { headers, rawHeaders } = parseHeadersFromLatin(headerLatin);
  const textParts = [];
  const htmlParts = [];
  for (const part of fetched.bodyParts || []) {
    const bytes = decodeTransfer(part.raw || Buffer.alloc(0), part.encoding || '');
    const text = decodeBytes(bytes, part.charset || 'utf-8');
    if (part.subtype === 'html') htmlParts.push(text);
    else textParts.push(text);
  }
  const text = textParts.join('\n\n').trim();
  const html = htmlParts.join('\n\n').trim();
  const bodyText = (text || stripHtml(html) || '').trim();
  return {
    subject: decodeMimeWords(headers.subject || ''),
    from: decodeMimeWords(headers.from || ''),
    to: decodeMimeWords(headers.to || ''),
    cc: decodeMimeWords(headers.cc || ''),
    bcc: decodeMimeWords(headers.bcc || ''),
    date: headers.date || '',
    messageId: (headers['message-id'] || '').trim(),
    inReplyTo: (headers['in-reply-to'] || '').trim(),
    references: (headers.references || '').trim(),
    text,
    html,
    bodyText,
    attachments: Array.isArray(fetched.attachments) ? fetched.attachments : [],
    headers,
    rawHeaders
  };
}

class ImapClientM1 {
  constructor(settings) {
    this.settings = settings;
    this.socket = null;
    this.tag = 1;
    this.pending = null;
    this.closed = false;
  }
  async connect() {
    return new Promise((resolve, reject) => {
      let buffer = Buffer.alloc(0);
      let done = false;
      const timeoutMs = Number(this.settings.connectTimeoutMs || 60000);
      const socket = tls.connect({
        host: this.settings.imapHost,
        port: Number(this.settings.imapPort || 993),
        rejectUnauthorized: !!this.settings.tlsRejectUnauthorized,
        servername: this.settings.imapHost,
        timeout: timeoutMs
      });
      this.socket = socket;
      this.closed = false;
      const cleanup = () => { socket.removeListener('data', onGreeting); };
      const fail = err => { if (!done) { done = true; cleanup(); reject(err); } };
      const onGreeting = chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        const s = buffer.toString('latin1');
        if (/^\* OK/m.test(s)) { done = true; cleanup(); this._bindData(); resolve(); }
      };
      socket.on('data', onGreeting);
      socket.on('error', fail);
      socket.on('close', () => { this.closed = true; if (!done) fail(new Error('IMAP connection closed')); });
      socket.on('timeout', () => { try { socket.destroy(new Error('IMAP connect timeout')); } catch {} });
    });
  }
  _bindData() {
    this.socket.on('data', chunk => {
      if (!this.pending) return;
      this.pending.chunks.push(chunk);
      const buf = Buffer.concat(this.pending.chunks);
      const latin = buf.toString('latin1');
      const doneRe = new RegExp(`\\r?\\n${this.pending.tag} (OK|NO|BAD)`, 'i');
      if (doneRe.test(latin) || latin.startsWith(`${this.pending.tag} `)) {
        const p = this.pending;
        this.pending = null;
        if (p.timer) clearTimeout(p.timer);
        if (new RegExp(`${p.tag} OK`, 'i').test(latin)) p.resolve(buf);
        else p.reject(new Error(latin.split('\n').slice(-3).join('\n')));
      }
    });
    this.socket.on('error', err => { if (this.pending) { const p = this.pending; this.pending = null; if (p.timer) clearTimeout(p.timer); p.reject(err); } });
    this.socket.on('close', () => { this.closed = true; if (this.pending) { const p = this.pending; this.pending = null; if (p.timer) clearTimeout(p.timer); p.reject(new Error('IMAP connection closed')); } });
  }
  command(cmd) {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.closed) return reject(new Error('IMAP socket is not connected'));
      if (this.pending) return reject(new Error('IMAP command already pending'));
      const tag = 'A' + String(this.tag++).padStart(4, '0');
      const timeoutMs = Number(this.settings.commandTimeoutMs || 60000);
      const timer = timeoutMs > 0 ? setTimeout(() => {
        const p = this.pending;
        this.pending = null;
        try { this.socket.destroy(new Error('IMAP command timeout')); } catch {}
        if (p) p.reject(new Error(`IMAP command timeout: ${cmd.slice(0, 80)}`));
      }, timeoutMs) : null;
      this.pending = { tag, chunks: [], timer, resolve, reject };
      this.socket.write(`${tag} ${cmd}\r\n`);
    });
  }
  async login() { await this.command(`LOGIN ${quoteImap(this.settings.username)} ${quoteImap(this.settings.appPassword)}`); }
  async logout() { try { await this.command('LOGOUT'); } catch {} try { this.socket.end(); } catch {} this.closed = true; }
  abort() { try { this.socket.destroy(new Error('cancelled')); } catch {} this.closed = true; }
  async listMailboxes() {
    const buf = await this.command('LIST "" "*"');
    const lines = buf.toString('latin1').split(/\r?\n/);
    const out = [];
    for (const line of lines) {
      const m = /^\* LIST \(([^)]*)\)\s+"([^"]*)"\s+(.+)$/i.exec(line.trim());
      if (!m) continue;
      let name = m[3].trim();
      if (name.startsWith('"') && name.endsWith('"')) name = name.slice(1, -1);
      out.push(decodeMimeWords(name));
    }
    return out.sort((a, b) => a.localeCompare(b, 'ru'));
  }
  async select(mailbox) { await this.command(`SELECT ${quoteImap(mailbox)}`); }
  async searchByDate(from, to) {
    const buf = await this.command(`UID SEARCH ${buildDateCriteria(from, to)}`);
    const line = buf.toString('latin1').split(/\r?\n/).find(x => x.startsWith('* SEARCH')) || '* SEARCH';
    return line.replace(/^\* SEARCH\s*/i, '').trim().split(/\s+/).filter(Boolean);
  }
  async fetchMeta(uid) {
    const buf = await this.command(`UID FETCH ${uid} (UID FLAGS BODYSTRUCTURE BODY.PEEK[HEADER])`);
    return parseFetchMetaResponse(buf, uid);
  }
  async fetchBodyPart(uid, partId) {
    const section = String(partId || 'TEXT').replace(/[^0-9.TEXT]/gi, '') || 'TEXT';
    const buf = await this.command(`UID FETCH ${uid} (BODY.PEEK[${section}])`);
    const literals = extractLiterals(buf);
    return literals[0] || Buffer.alloc(0);
  }
  async fetchTextOnly(uid, options = {}) {
    const meta = await this.fetchMeta(uid);
    const bodyInfo = analyzeBodyStructure(meta.bodyStructure);
    const selectedParts = bodyInfo.selectedParts && bodyInfo.selectedParts.length ? bodyInfo.selectedParts : [{ partId: 'TEXT', subtype: 'plain', charset: 'utf-8', encoding: '' }];
    const bodyParts = [];
    for (const part of selectedParts) {
      const raw = await this.fetchBodyPart(meta.uid || uid, part.partId);
      bodyParts.push({ ...part, raw });
    }
    const attachments = [];
    if (Array.isArray(bodyInfo.attachmentParts)) {
      for (const att of bodyInfo.attachmentParts) {
        const item = { ...att };
        if (options.saveAttachments && (!options.allowedAttachment || options.allowedAttachment(att.filename || ''))) {
          const raw = await this.fetchBodyPart(meta.uid || uid, att.partId);
          item.data = decodeTransfer(raw, att.encoding || '');
          item.savedCandidate = true;
        }
        attachments.push(item);
      }
    }
    return { uid: meta.uid || String(uid), flags: meta.flags || '', headerRaw: meta.headerRaw || Buffer.alloc(0), bodyParts, hasAttachments: !!bodyInfo.hasAttachments, attachments };
  }
}

function buildRecord({ mailbox, fetched, parsed, settings, preset }) {
  const userSet = new Set([settings.username, ...(splitTerms(settings.userAliases || ''))].map(x => x.toLowerCase()).filter(Boolean));
  const fromEmails = extractEmails(parsed.from);
  const toEmails = extractEmails(parsed.to);
  const ccEmails = extractEmails(parsed.cc);
  const isFromUser = fromEmails.some(e => userSet.has(e)) || isSentMailbox(mailbox);
  const isToUser = toEmails.some(e => userSet.has(e));
  const isCcUser = ccEmails.some(e => userSet.has(e));
  const direction = isFromUser ? 'outgoing' : 'incoming';
  const normalizedSubject = normalizeSubject(parsed.subject || 'Без темы');
  // Для рабочей аналитики основной threadKey строится по нормализованной теме; серверные References/In-Reply-To сохраняются отдельным ключом.
  const subjectThreadSeed = normalizedSubject || parsed.messageId || `${mailbox}:${fetched.uid}`;
  const referenceThreadSeed = parsed.references || parsed.inReplyTo || parsed.messageId || subjectThreadSeed;
  const threadKey = hmac8('mail-dump-thread-subject', subjectThreadSeed);
  const referenceThreadKey = hmac8('mail-dump-thread-reference', referenceThreadSeed);
  const dateObj = parseEmailDate(parsed.date);
  const bodyRaw = parsed.bodyText || '';
  let cleanBody = preset.content?.keepOriginalBody
    ? bodyRaw
    : stripHistoryAndSignatures(bodyRaw, { stripHistory: preset.content?.stripHistory !== false, stripSignatures: preset.content?.stripSignatures !== false, keepForwarded: preset.content?.keepForwarded !== false, replyChainStartMarker: preset.content?.replyChainStartMarker || '' });
  const cleaningLostBody = !preset.content?.keepOriginalBody && String(bodyRaw || '').trim().length > 0 && String(cleanBody || '').trim().length === 0;
  if (cleaningLostBody) cleanBody = bodyRaw;
  return {
    uid: fetched.uid,
    mailbox,
    flags: fetched.flags || '',
    dateObj,
    date: formatDateTime(dateObj),
    direction,
    from: parsed.from || '',
    to: parsed.to || '',
    cc: parsed.cc || '',
    subject: parsed.subject || 'Без темы',
    normalizedSubject,
    messageId: parsed.messageId || '',
    inReplyTo: parsed.inReplyTo || '',
    references: parsed.references || '',
    threadKey,
    referenceThreadKey,
    hasAttachments: (parsed.attachments || []).length > 0,
    attachments: parsed.attachments || [],
    isFromUser,
    isToUser,
    isCcUser,
    body: cleanBody,
    bodyWasCleaned: !preset.content?.keepOriginalBody && !cleaningLostBody,
    bodyCleaningFallback: cleaningLostBody,
    bodyLength: cleanBody.length
  };
}
function recordMatches(record, preset) {
  const inc = preset.filters?.include || {};
  const exc = preset.filters?.exclude || {};
  if (!containsAllNeedles(record.from, inc.from)) return false;
  if (!containsAllNeedles(`${record.to}\n${record.cc}`, inc.to)) return false;
  if (!containsAllNeedles(record.subject, inc.subject)) return false;
  if (containsAnyNeedles(record.from, exc.from)) return false;
  if (containsAnyNeedles(`${record.to}\n${record.cc}`, exc.to)) return false;
  if (containsAnyNeedles(record.subject, exc.subject)) return false;
  return true;
}
function dedupeByMessageId(records) {
  // Одно физическое письмо часто попадает и в Sent, и в INBOX (self-cc/групповые рассылки).
  // Дедуплицируем по messageId, сохраняем приоритет outgoing (Sent), собираем все источники.
  const byId = new Map();
  const out = [];
  let removed = 0;
  for (const r of records) {
    const id = String(r.messageId || '').trim();
    if (!id) { out.push(r); continue; }
    const prev = byId.get(id);
    if (!prev) {
      r.sourceMailboxes = [r.mailbox];
      r.sourceUids = [{ mailbox: r.mailbox, uid: r.uid }];
      byId.set(id, r);
      out.push(r);
      continue;
    }
    removed += 1;
    if (!prev.sourceMailboxes.includes(r.mailbox)) prev.sourceMailboxes.push(r.mailbox);
    prev.sourceUids.push({ mailbox: r.mailbox, uid: r.uid });
    // Outgoing-копия побеждает incoming-копию того же messageId.
    if (r.direction === 'outgoing' && prev.direction !== 'outgoing') {
      const idx = out.indexOf(prev);
      r.sourceMailboxes = prev.sourceMailboxes;
      r.sourceUids = prev.sourceUids;
      if (idx !== -1) out[idx] = r;
      byId.set(id, r);
    }
  }
  return { records: out, removed };
}
function markUnanswered(records, settings) {
  const thresholdH = Number(settings.unansweredThresholdHours || 0);
  if (!(thresholdH > 0)) {
    for (const r of records) r.unansweredOverThreshold = false;
    return 0;
  }
  const thresholdMs = thresholdH * 3600 * 1000;
  const now = Date.now();
  const byThread = new Map();
  for (const r of records) {
    if (!byThread.has(r.threadKey)) byThread.set(r.threadKey, []);
    byThread.get(r.threadKey).push(r);
    r.unansweredOverThreshold = false;
  }
  let count = 0;
  for (const arr of byThread.values()) {
    arr.sort((a, b) => (a.dateObj?.getTime?.() || 0) - (b.dateObj?.getTime?.() || 0));
    const last = arr[arr.length - 1];
    if (!last) continue;
    if (last.direction !== 'incoming') continue;
    const ts = last.dateObj?.getTime?.() || 0;
    if (!ts) continue;
    if ((now - ts) > thresholdMs) {
      last.unansweredOverThreshold = true;
      count += 1;
    }
  }
  return count;
}
function computeStats(records, found, settings) {
  const keyEmail = String(settings.keyContactEmail || '').toLowerCase().trim();
  const threads = new Map();
  const contacts = new Map();
  for (const r of records) {
    if (!threads.has(r.threadKey)) threads.set(r.threadKey, []);
    threads.get(r.threadKey).push(r);
    for (const email of extractEmails(`${r.from}\n${r.to}\n${r.cc}`)) contacts.set(email, (contacts.get(email) || 0) + 1);
  }
  return {
    found,
    afterFilters: records.length,
    incoming: records.filter(r => r.direction === 'incoming').length,
    outgoing: records.filter(r => r.direction === 'outgoing').length,
    directToUser: records.filter(r => r.isToUser).length,
    ccToUser: records.filter(r => r.isCcUser).length,
    fromKeyContact: keyEmail ? records.filter(r => extractEmails(r.from).includes(keyEmail)).length : 0,
    withAttachments: records.filter(r => r.hasAttachments).length,
    threadCount: threads.size,
    contactCount: contacts.size,
    unansweredCount: records.filter(r => r.unansweredOverThreshold).length,
    threads,
    contacts
  };
}
function buildDigestMarkdown({ preset, settings, range, records, stats, runEntry, status }) {
  const period = formatPeriodLabel(range.from, range.to);
  const sorted = sortRecords(records, preset);
  const now = new Date();
  const lines = [];
  lines.push('---');
  lines.push('type: mail_analysis_ready_digest');
  lines.push(`schema_version: 4`);
  lines.push(`period_from: "${formatDateFolder(range.from)}"`);
  lines.push(`period_to: "${formatDateFolder(range.to)}"`);
  lines.push(`preset_id: "${preset.id}"`);
  lines.push(`preset_name: "${String(preset.name || '').replace(/"/g, '\\"')}"`);
  lines.push(`mailboxes: ${JSON.stringify(preset.source?.mailboxes || [])}`);
  lines.push(`mode: "digest_only_analysis_ready"`);
  lines.push(`status: "${status || 'completed'}"`);
  lines.push(`total_found: ${stats.found}`);
  lines.push(`total_after_filters: ${stats.afterFilters}`);
  lines.push(`incoming: ${stats.incoming}`);
  lines.push(`outgoing: ${stats.outgoing}`);
  lines.push(`direct_to_user: ${stats.directToUser}`);
  lines.push(`cc_to_user: ${stats.ccToUser}`);
  lines.push(`with_attachments: ${stats.withAttachments}`);
  lines.push(`threads: ${stats.threadCount}`);
  lines.push(`unanswered_threshold_hours: ${Number(settings.unansweredThresholdHours || 0)}`);
  lines.push(`unanswered_over_threshold_count: ${stats.unansweredCount}`);
  lines.push(`deduped_message_id_copies: ${Number(runEntry?.counts?.deduped || 0)}`);
  lines.push(`created_at: "${formatDateTime(now)}"`);
  lines.push(`run_id: "${runEntry.runId}"`);
  lines.push('---', '');
  lines.push(`# ${preset.emoji || '📧'} ${escapeMdInline(preset.output?.exportName || preset.name || 'Почтовая сводка')}: ${period}`, '');
  lines.push('## 1. Параметры запуска', '');
  lines.push(`- Пресет: ${escapeMdInline(preset.name)}`);
  lines.push(`- Период: ${formatDateFolder(range.from)} → ${formatDateFolder(range.to)}`);
  lines.push(`- Папки IMAP: ${(preset.source?.mailboxes || []).map(escapeMdInline).join(', ') || 'не выбраны'}`);
  lines.push(`- Режим: .md-сводка в корне MailDump${shouldSaveMailNotes(preset) ? ' + .md писем' : ''}${shouldSaveAttachments(preset) ? ' + вложения рядом с письмами' : ''}`);
  lines.push(`- Тела писем: полностью, без ограничения символов`);
  lines.push(`- Цепочки/подписи вырезались: ${preset.content?.keepOriginalBody ? 'нет, оставлен исходный текст' : 'да'}`);
  lines.push(`- Порог писем без ответа: ${Number(settings.unansweredThresholdHours || 7)} ч`, '');
  lines.push('## 2. Технические счётчики', '');
  lines.push('| Показатель | Значение |');
  lines.push('|---|---:|');
  lines.push(`| Найдено на сервере | ${stats.found} |`);
  lines.push(`| Прошло фильтры | ${stats.afterFilters} |`);
  lines.push(`| Входящие | ${stats.incoming} |`);
  lines.push(`| Исходящие | ${stats.outgoing} |`);
  lines.push(`| Пользователь в To | ${stats.directToUser} |`);
  lines.push(`| Пользователь в CC | ${stats.ccToUser} |`);
  if (settings.keyContactEmail) lines.push(`| Входящие от ${escapeMdInline(settings.keyContactEmail)} | ${stats.fromKeyContact} |`);
  lines.push(`| Писем с признаком вложений | ${stats.withAttachments} |`);
  lines.push(`| Цепочек по теме | ${stats.threadCount} |`);
  lines.push(`| Без ответа > ${Number(settings.unansweredThresholdHours || 0)} ч | ${stats.unansweredCount} |`);
  if (Number(runEntry?.counts?.deduped || 0) > 0) lines.push(`| Дублей по Message-ID удалено | ${runEntry.counts.deduped} |`);
  lines.push(`| Уникальных контактов | ${stats.contactCount} |`, '');
  lines.push('## 3. Фильтры', '');
  lines.push('### Включить');
  const inc = preset.filters?.include || {};
  const exc = preset.filters?.exclude || {};
  const incLines = [];
  if (inc.from) incLines.push(`- От: ${escapeMdInline(inc.from)}`);
  if (inc.to) incLines.push(`- Кому/копия: ${escapeMdInline(inc.to)}`);
  if (inc.subject) incLines.push(`- Тема: ${escapeMdInline(inc.subject)}`);
  lines.push(...(incLines.length ? incLines : ['- Нет']));
  lines.push('', '### Исключить');
  const excLines = [];
  if (exc.from) excLines.push(`- От: ${escapeMdInline(exc.from)}`);
  if (exc.to) excLines.push(`- Кому/копия: ${escapeMdInline(exc.to)}`);
  if (exc.subject) excLines.push(`- Тема: ${escapeMdInline(exc.subject)}`);
  lines.push(...(excLines.length ? excLines : ['- Нет']), '');
  lines.push('## 4. Индекс цепочек по теме', '');
  lines.push('| threadKey по теме | Писем | Первое письмо | Последнее письмо | Нормализованная тема | Участники |');
  lines.push('|---|---:|---|---|---|---|');
  const threadRows = Array.from(stats.threads.entries()).map(([key, arr]) => {
    const ordered = arr.slice().sort((a, b) => a.dateObj - b.dateObj);
    const subject = ordered[0]?.normalizedSubject || ordered[0]?.subject || '';
    const participants = Array.from(new Set(ordered.flatMap(r => extractEmails(`${r.from}\n${r.to}\n${r.cc}`)))).slice(0, 8).join(', ');
    return { key, count: arr.length, first: ordered[0]?.date || '', last: ordered[ordered.length - 1]?.date || '', subject, participants };
  }).sort((a, b) => b.count - a.count || a.subject.localeCompare(b.subject, 'ru'));
  for (const t of threadRows) lines.push(`| ${t.key} | ${t.count} | ${escapeMdInline(t.first)} | ${escapeMdInline(t.last)} | ${escapeMdInline(t.subject)} | ${escapeMdInline(t.participants)} |`);
  if (!threadRows.length) lines.push('| — | 0 | — | — | — | — |');
  lines.push('');
  lines.push('## 5. Ключевые контакты по выгрузке', '');
  lines.push('| Контакт | Кол-во упоминаний в From/To/CC |');
  lines.push('|---|---:|');
  const contacts = Array.from(stats.contacts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 50);
  for (const [email, count] of contacts) lines.push(`| ${escapeMdInline(email)} | ${count} |`);
  if (!contacts.length) lines.push('| — | 0 |');
  lines.push('');
  lines.push(`## 6. Потенциально без ответа > ${Number(settings.unansweredThresholdHours || 0)} ч`, '');
  const unanswered = sorted.filter(r => r.unansweredOverThreshold);
  if (!Number(settings.unansweredThresholdHours || 0)) {
    lines.push('Порог не задан — раздел не рассчитан.', '');
  } else if (!unanswered.length) {
    lines.push('Таких писем нет: либо на каждое входящее в выгрузке последнее письмо в цепочке исходящее, либо время ожидания меньше порога.', '');
  } else {
    lines.push('| Дата входящего | От | Тема | threadKey | Часов прошло |');
    lines.push('|---|---|---|---|---:|');
    const nowMs = Date.now();
    for (const r of unanswered) {
      const ageH = r.dateObj ? Math.round((nowMs - r.dateObj.getTime()) / 36e5) : '—';
      lines.push(`| ${escapeMdInline(r.date)} | ${escapeMdInline(r.from)} | ${escapeMdInline(r.subject)} | ${r.threadKey} | ${ageH} |`);
    }
    lines.push('');
  }
  lines.push('## 7. Письма', '');
  if (!sorted.length) {
    lines.push('Писем по заданным папкам и фильтрам не найдено.', '');
  }
  let n = 1;
  for (const r of sorted) {
    const title = `[${String(n).padStart(4, '0')}] ${r.direction === 'outgoing' ? '📤' : '📥'} ${escapeMdInline(r.subject || 'Без темы')}`;
    lines.push(`### ${title}`);
    lines.push('');
    lines.push('```yaml');
    lines.push(`uid: "${String(r.uid || '').replace(/"/g, '\\"')}"`);
    lines.push(`mailbox: "${String(r.mailbox || '').replace(/"/g, '\\"')}"`);
    if (Array.isArray(r.sourceMailboxes) && r.sourceMailboxes.length > 1) lines.push(`source_mailboxes: ${JSON.stringify(r.sourceMailboxes)}`);
    lines.push(`direction: "${r.direction}"`);
    lines.push(`date: "${r.date}"`);
    lines.push(`from: "${String(r.from || '').replace(/"/g, '\\"')}"`);
    if (preset.content?.includeTo !== false) lines.push(`to: "${String(r.to || '').replace(/"/g, '\\"')}"`);
    if (preset.content?.includeCc !== false) lines.push(`cc: "${String(r.cc || '').replace(/"/g, '\\"')}"`);
    lines.push(`subject: "${String(r.subject || '').replace(/"/g, '\\"')}"`);
    lines.push(`normalized_subject: "${String(r.normalizedSubject || '').replace(/"/g, '\\"')}"`);
    lines.push(`message_id: "${String(r.messageId || '').replace(/"/g, '\\"')}"`);
    if (preset.content?.includeReferences !== false) {
      lines.push(`in_reply_to: "${String(r.inReplyTo || '').replace(/"/g, '\\"')}"`);
      lines.push(`references: "${String(r.references || '').replace(/"/g, '\\"')}"`);
    }
    lines.push(`thread_key: "${r.threadKey}"`);
    if (preset.content?.includeReferences !== false) lines.push(`reference_thread_key: "${r.referenceThreadKey || ''}"`);
    lines.push(`flags: "${String(r.flags || '').replace(/"/g, '\\"')}"`);
    lines.push(`is_encrypted: ${/\bencrypted\b/i.test(String(r.flags || '')) ? 'true' : 'false'}`);
    lines.push(`is_from_user: ${r.isFromUser ? 'true' : 'false'}`);
    if (preset.content?.includeTo !== false) lines.push(`is_to_user: ${r.isToUser ? 'true' : 'false'}`);
    if (preset.content?.includeCc !== false) lines.push(`is_cc_user: ${r.isCcUser ? 'true' : 'false'}`);
    lines.push(`unanswered_over_threshold: ${r.unansweredOverThreshold ? 'true' : 'false'}`);
    if (preset.content?.includeAttachments !== false) {
      lines.push(`has_attachments: ${r.hasAttachments ? 'true' : 'false'}`);
      lines.push(`attachments_count: ${r.attachments.length}`);
      if (r.attachments && r.attachments.length) lines.push(`attachments: ${JSON.stringify(r.attachments.map(a => a.filename || 'attachment.bin'))}`);
    }
    lines.push(`body_was_cleaned: ${r.bodyWasCleaned ? 'true' : 'false'}`);
    lines.push(`body_cleaning_fallback: ${r.bodyCleaningFallback ? 'true' : 'false'}`);
    lines.push(`body_length: ${r.bodyLength}`);
    lines.push('```');
    lines.push('');
    if (preset.content?.includeAttachments !== false && r.hasAttachments) {
      if (r.attachmentPaths && r.attachmentPaths.length) {
        lines.push('**Сохранённые вложения:**');
        for (const rel of r.attachmentPaths) lines.push(`- [[${rel}|${path.basename(rel)}]]`);
      } else {
        lines.push('**Вложения не скачивались / не прошли фильтр расширений:**');
        for (const a of r.attachments) lines.push(`- ${escapeMdInline(a.filename || 'attachment.bin')} · ${escapeMdInline(a.contentType || '')}`);
      }
      lines.push('');
    }
    if (r.notePath) lines.push(`**Файл письма:** [[${r.notePath}|${path.basename(r.notePath)}]]`, '');
    lines.push('**Тело письма:**', '');
    lines.push(escapeMdBlock(r.body || ''));
    lines.push('');
    n += 1;
  }
  return lines.join('\n');
}


function shouldSaveMailNotes(preset) { return !!preset?.artifacts?.saveMailNotes; }
function shouldSaveAttachments(preset) { return !!preset?.artifacts?.saveAttachments; }
function getMailRecordFolderAbs(outputAbs, preset, record) {
  const sub = sanitizeFileName(preset.output?.subfolder || preset.name || 'Письма');
  let folder = path.join(outputAbs, sub);
  const group = getGroupingFolderName(record.dateObj, preset.output?.grouping || 'none');
  if (group) folder = path.join(folder, sanitizeFileName(group));
  ensureFolder(folder);
  return folder;
}
function writeMailRecordWithAttachments({ basePath, outputAbs, preset, record, runEntry }) {
  if (!shouldSaveMailNotes(preset)) return;
  const folderAbs = getMailRecordFolderAbs(outputAbs, preset, record);
  const relFolder = toRel(basePath, folderAbs);
  if (!runEntry.foldersTouched.includes(relFolder)) runEntry.foldersTouched.push(relFolder);
  const prefix = formatFileTimePrefix(record.dateObj, record.uid);
  const subjectPart = sanitizeFileName(record.subject || 'Без темы').slice(0, 80);
  const savedAttachments = [];
  if (shouldSaveAttachments(preset)) {
    for (const att of record.attachments || []) {
      if (!att || att.notDownloaded || !att.data) continue;
      if (!attachmentAllowed(att.filename || '', preset)) continue;
      const attName = uniqueFileName(folderAbs, `${prefix}_${sanitizeFileName(att.filename || 'attachment.bin')}`);
      const attAbs = path.join(folderAbs, attName);
      fs.writeFileSync(attAbs, att.data);
      const rel = toRel(basePath, attAbs);
      runEntry.filesCreated.push(rel);
      savedAttachments.push(rel);
    }
  }
  record.attachmentPaths = savedAttachments;
  const noteName = uniqueFileName(folderAbs, `${prefix}_${subjectPart}.md`);
  const noteAbs = path.join(folderAbs, noteName);
  const noteRel = toRel(basePath, noteAbs);
  const lines = [];
  lines.push('---');
  lines.push('type: mail_message');
  lines.push(`date: "${record.date}"`);
  lines.push(`mailbox: "${String(record.mailbox || '').replace(/"/g, '\\"')}"`);
  lines.push(`uid: "${record.uid}"`);
  lines.push(`direction: "${record.direction}"`);
  lines.push(`from: "${String(record.from || '').replace(/"/g, '\\"')}"`);
  lines.push(`to: "${String(record.to || '').replace(/"/g, '\\"')}"`);
  lines.push(`cc: "${String(record.cc || '').replace(/"/g, '\\"')}"`);
  lines.push(`subject: "${String(record.subject || '').replace(/"/g, '\\"')}"`);
  lines.push(`message_id: "${String(record.messageId || '').replace(/"/g, '\\"')}"`);
  lines.push(`thread_key: "${record.threadKey}"`);
  lines.push(`reference_thread_key: "${record.referenceThreadKey || ''}"`);
  lines.push(`has_attachments: ${record.hasAttachments ? 'true' : 'false'}`);
  lines.push('---', '');
  lines.push(`# ${escapeMdInline(record.subject || 'Без темы')}`, '');
  lines.push('## Метаданные');
  lines.push(`- Дата: ${record.date}`);
  lines.push(`- Папка: ${escapeMdInline(record.mailbox)}`);
  lines.push(`- Направление: ${record.direction}`);
  lines.push(`- От: ${escapeMdInline(record.from)}`);
  lines.push(`- Кому: ${escapeMdInline(record.to)}`);
  if (record.cc) lines.push(`- Копия: ${escapeMdInline(record.cc)}`);
  lines.push(`- Message-ID: ${escapeMdInline(record.messageId)}`);
  lines.push(`- ThreadKey по теме: ${escapeMdInline(record.threadKey)}`);
  lines.push(`- ReferenceThreadKey: ${escapeMdInline(record.referenceThreadKey || '')}`, '');
  lines.push('## Тело письма', '', escapeMdBlock(record.body || ''), '');
  if (savedAttachments.length) {
    lines.push('## Вложения');
    for (const rel of savedAttachments) lines.push(`- [[${rel}|${path.basename(rel)}]]`);
    lines.push('');
  } else if (record.hasAttachments) {
    lines.push('## Вложения', '', '- Есть вложения, но они не сохранены по настройкам расширений.', '');
  }
  fs.writeFileSync(noteAbs, lines.join('\n'), 'utf8');
  runEntry.filesCreated.push(noteRel);
  record.notePath = noteRel;
}

class ExportService {
  constructor(plugin) { this.plugin = plugin; }
  async makeClient() {
    const appPassword = await this.plugin.resolveAppPassword();
    const client = new ImapClientM1({ ...this.plugin.settings, appPassword });
    this.plugin.activeClient = client;
    try { await client.connect(); await client.login(); return client; }
    catch (e) { try { client.abort(); } catch {} this.plugin.activeClient = null; throw e; }
  }
  async loadMailboxes() {
    const token = this.plugin.ops.start('folders', { text: 'Загрузка IMAP-папок...', progressMode: 'indeterminate' });
    let client = null;
    try {
      client = await this.makeClient();
      const boxes = await client.listMailboxes();
      await client.logout();
      this.plugin.activeClient = null;
      this.plugin.availableMailboxes = boxes;
      this.plugin.ops.update({ text: `Папок загружено: ${boxes.length}`, progress: 100, progressMode: 'percent' });
      return boxes;
    } finally {
      if (client && !client.closed) { try { await client.logout(); } catch {} }
      this.plugin.activeClient = null;
      this.plugin.ops.finish(token, token.cancelled ? 'cancelled' : 'completed');
    }
  }
  async preflight(preset) {
    const token = this.plugin.ops.start('preflight', { text: `Оценка объёма: ${preset.name}`, progressMode: 'indeterminate' });
    let client = null;
    try {
      const range = resolveDateRange(preset);
      client = await this.makeClient();
      const counts = {};
      let total = 0;
      for (const mailbox of preset.source.mailboxes || []) {
        if (token.cancelled) throw new Error('Операция остановлена пользователем');
        this.plugin.ops.update({ text: `Оценка: ${mailbox}` });
        await client.select(mailbox);
        const uids = await client.searchByDate(range.from, range.to);
        counts[mailbox] = uids.length;
        total += uids.length;
      }
      await client.logout();
      this.plugin.activeClient = null;
      const warn = total > Number(this.plugin.settings.maxMessagesWarning || 300) ? ' · большой объём' : '';
      this.plugin.ops.update({ text: `Найдено по датам: ${total}${warn}`, progress: 100, progressMode: 'percent', counts });
      return { total, counts };
    } finally {
      if (client && !client.closed) { try { await client.logout(); } catch {} }
      this.plugin.activeClient = null;
      this.plugin.ops.finish(token, token.cancelled ? 'cancelled' : 'completed');
    }
  }
  async runPreset(preset) {
    const token = this.plugin.ops.start('export', { text: `Старт сводки: ${preset.name}`, progress: 0, progressMode: 'indeterminate', presetName: preset.name });
    let client = null;
    const basePath = this.plugin.app.vault.adapter.getBasePath();
    const outputAbs = path.join(basePath, this.plugin.settings.outputFolder || 'MailDump');
    const summariesAbs = outputAbs;
    ensureFolder(summariesAbs);
    const range = resolveDateRange(preset);
    const runEntry = {
      runId: `run_${nowIsoSafe()}_${crypto.randomBytes(3).toString('hex')}`,
      startedAt: formatDateTime(new Date()),
      finishedAt: '',
      status: 'running',
      presetId: preset.id,
      presetName: preset.name,
      mode: 'digest_only_analysis_ready',
      mailboxes: preset.source?.mailboxes || [],
      counts: { found: 0, afterFilters: 0, written: 0, errors: 0 },
      filesCreated: [],
      foldersTouched: [toRel(basePath, outputAbs)],
      errors: []
    };
    const records = [];
    try {
      client = await this.makeClient();
      const mailboxes = preset.source?.mailboxes || [];
      for (let m = 0; m < mailboxes.length; m++) {
        const mailbox = mailboxes[m];
        if (token.cancelled) throw new Error('Операция остановлена пользователем');
        this.plugin.ops.update({ text: `Переход к папке: ${mailbox}`, progressMode: 'indeterminate' });
        await client.select(mailbox);
        const uids = await client.searchByDate(range.from, range.to);
        runEntry.counts.found += uids.length;
        let processed = 0;
        const batchSize = Math.max(1, Math.min(50, Number(preset.performance?.fetchBatchSize || this.plugin.settings.fetchBatchSize || 10)));
        for (const uidBatch of chunkArray(uids, batchSize)) {
          if (token.cancelled) throw new Error('Операция остановлена пользователем');
          this.plugin.ops.update({ text: `${mailbox}: пакет ${Math.floor(processed / batchSize) + 1}/${Math.max(1, Math.ceil(uids.length / batchSize))}`, progress: uids.length ? Math.round((processed / uids.length) * 100) : 100, progressMode: 'percent' });
          for (const uid of uidBatch) {
          if (token.cancelled) throw new Error('Операция остановлена пользователем');
          this.plugin.ops.update({ text: `${mailbox}: загрузка текста ${processed + 1}/${uids.length}`, progress: uids.length ? Math.round((processed / uids.length) * 100) : 100, progressMode: 'percent' });
          let fetched;
          try {
            fetched = await client.fetchTextOnly(uid, { saveAttachments: shouldSaveAttachments(preset), allowedAttachment: filename => attachmentAllowed(filename, preset) });
          } catch (e) {
            runEntry.errors.push({ mailbox, uid, error: e.message || String(e) });
            runEntry.counts.errors += 1;
            if (token.cancelled) throw new Error('Операция остановлена пользователем');
            if (client && client.closed) {
              try { await client.logout(); } catch {}
              this.plugin.activeClient = null;
              client = await this.makeClient();
              await client.select(mailbox);
            }
            processed += 1;
            continue;
          }
          try {
            const parsed = parseFetchedTextOnlyEmail(fetched);
            const record = buildRecord({ mailbox, fetched, parsed, settings: this.plugin.settings, preset });
            if (recordMatches(record, preset)) {
              writeMailRecordWithAttachments({ basePath, outputAbs, preset, record, runEntry });
              records.push(record);
            }
          } catch (e) {
            runEntry.errors.push({ mailbox, uid: fetched.uid || uid, error: e.message || String(e) });
            runEntry.counts.errors += 1;
          }
          processed += 1;
          runEntry.counts.afterFilters = records.length;
          await waitTick();
          }
        }
      }
      await client.logout();
      this.plugin.activeClient = null;
      const dedup = dedupeByMessageId(records);
      const finalRecords = dedup.records;
      runEntry.counts.deduped = dedup.removed;
      runEntry.counts.afterFilters = finalRecords.length;
      markUnanswered(finalRecords, this.plugin.settings);
      const stats = computeStats(finalRecords, runEntry.counts.found, this.plugin.settings);
      const digest = buildDigestMarkdown({ preset, settings: this.plugin.settings, range, records: finalRecords, stats, runEntry, status: 'completed' });
      const title = sanitizeFileName(`${preset.output?.summaryPrefix ? preset.output.summaryPrefix + '_' : ''}${preset.output?.exportName || preset.name} ${formatPeriodLabel(range.from, range.to)}.md`);
      const abs = path.join(summariesAbs, uniqueFileName(summariesAbs, title));
      fs.writeFileSync(abs, digest, 'utf8');
      const rel = toRel(basePath, abs);
      runEntry.filesCreated.push(rel);
      runEntry.counts.written = runEntry.filesCreated.length;
      runEntry.finishedAt = formatDateTime(new Date());
      runEntry.status = 'completed';
      new RunLogStore(this.plugin).append(runEntry);
      this.plugin.ops.update({ text: `Сводка создана: ${rel}`, progress: 100, progressMode: 'percent', resultPath: rel, counts: runEntry.counts });
      return { runEntry, path: rel };
    } catch (e) {
      const status = token.cancelled || /остановлена|closed|cancelled/i.test(String(e.message || e)) ? 'cancelled' : 'error';
      if (records.length) {
        try {
          const dedup = dedupeByMessageId(records);
          const finalRecords = dedup.records;
          runEntry.counts.deduped = dedup.removed;
          runEntry.counts.afterFilters = finalRecords.length;
          markUnanswered(finalRecords, this.plugin.settings);
          const stats = computeStats(finalRecords, runEntry.counts.found, this.plugin.settings);
          const digest = buildDigestMarkdown({ preset, settings: this.plugin.settings, range, records: finalRecords, stats, runEntry, status: 'partial' });
          const title = sanitizeFileName(`${preset.output?.summaryPrefix ? preset.output.summaryPrefix + '_' : ''}${preset.output?.exportName || preset.name} ${formatPeriodLabel(range.from, range.to)} PARTIAL.md`);
          const abs = path.join(summariesAbs, uniqueFileName(summariesAbs, title));
          fs.writeFileSync(abs, digest, 'utf8');
          runEntry.filesCreated.push(toRel(basePath, abs));
          runEntry.counts.written = runEntry.filesCreated.length;
        } catch (writeError) { runEntry.errors.push({ error: `partial write failed: ${writeError.message || writeError}` }); }
      }
      runEntry.finishedAt = formatDateTime(new Date());
      runEntry.status = records.length && status !== 'error' ? 'partial' : status;
      runEntry.errors.push({ error: e.message || String(e) });
      runEntry.counts.afterFilters = records.length;
      new RunLogStore(this.plugin).append(runEntry);
      throw e;
    } finally {
      if (client && !client.closed) { try { await client.logout(); } catch {} }
      this.plugin.activeClient = null;
      this.plugin.ops.finish(token, token.cancelled ? 'cancelled' : 'completed');
    }
  }
}

class CleanupService {
  constructor(plugin) { this.plugin = plugin; }
  get basePath() { return this.plugin.app.vault.adapter.getBasePath(); }
  get outputAbs() { return path.join(this.basePath, this.plugin.settings.outputFolder || 'MailDump'); }
  deleteLastDigest() {
    const log = new RunLogStore(this.plugin);
    const last = log.getLastDigestRun();
    if (!last) throw new Error('В журнале нет выгрузок для удаления');
    let deleted = 0;
    for (const rel of last.filesCreated || []) {
      const abs = relToAbs(this.basePath, rel);
      if (fileExists(abs) && fs.statSync(abs).isFile()) { fs.unlinkSync(abs); deleted += 1; }
    }
    log.append({ runId: `cleanup_${nowIsoSafe()}`, startedAt: formatDateTime(new Date()), finishedAt: formatDateTime(new Date()), status: 'cleanup', type: 'delete_last_digest', sourceRunId: last.runId, deletedFiles: deleted, filesCreated: [], foldersTouched: [] });
    return { deleted, run: last };
  }
  deleteOutputContents({ includeServiceJson = false } = {}) {
    const outputAbs = this.outputAbs;
    if (!fileExists(outputAbs)) return { deletedFiles: 0, deletedFolders: 0 };
    let deletedFiles = 0;
    let deletedFolders = 0;
    const serviceFiles = new Set([RUN_LOG_FILE, '_mail_dump_state.json', '_mapping.json']);
    const removeEntry = abs => {
      if (!fileExists(abs)) return;
      const st = fs.statSync(abs);
      if (st.isDirectory()) {
        for (const name of fs.readdirSync(abs)) removeEntry(path.join(abs, name));
        if (abs !== outputAbs) { try { fs.rmdirSync(abs); deletedFolders += 1; } catch {} }
      } else {
        if (!includeServiceJson && abs === path.join(outputAbs, RUN_LOG_FILE)) return;
        if (!includeServiceJson && serviceFiles.has(path.basename(abs))) return;
        try { fs.unlinkSync(abs); deletedFiles += 1; } catch {}
      }
    };
    for (const name of fs.readdirSync(outputAbs)) removeEntry(path.join(outputAbs, name));
    if (includeServiceJson) {
      try { fs.rmdirSync(outputAbs); deletedFolders += 1; } catch {}
    } else {
      new RunLogStore(this.plugin).append({ runId: `cleanup_${nowIsoSafe()}`, startedAt: formatDateTime(new Date()), finishedAt: formatDateTime(new Date()), status: 'cleanup', type: 'delete_all_keep_service_json', deletedFiles, deletedFolders, filesCreated: [], foldersTouched: [] });
    }
    return { deletedFiles, deletedFolders };
  }
}


function addField(parent, label, value, onChange, type = 'text') {
  const wrap = parent.createDiv({ cls: 'mail-dump-field' });
  wrap.createEl('label', { text: label });
  const input = wrap.createEl('input', { type });
  input.value = value == null ? '' : String(value);
  input.oninput = () => onChange(input.value);
  return input;
}
function addTextarea(parent, label, value, onChange) {
  const wrap = parent.createDiv({ cls: 'mail-dump-field' });
  wrap.createEl('label', { text: label });
  const input = wrap.createEl('textarea');
  input.value = value || '';
  input.oninput = () => onChange(input.value);
  return input;
}
function addSelect(parent, label, options, value, onChange) {
  const wrap = parent.createDiv({ cls: 'mail-dump-field' });
  wrap.createEl('label', { text: label });
  const select = wrap.createEl('select');
  for (const [v, t] of options) {
    const opt = select.createEl('option', { value: v, text: t });
    if (v === value) opt.selected = true;
  }
  select.onchange = () => onChange(select.value);
  return select;
}
function addCheck(parent, label, checked, onChange) {
  const row = parent.createEl('label', { cls: 'mail-dump-checkline' });
  const cb = row.createEl('input', { type: 'checkbox' });
  cb.checked = !!checked;
  row.createSpan({ text: label });
  cb.onchange = () => onChange(cb.checked);
  return cb;
}

class MailDumpView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.presets = [];
    this.currentPresetId = null;
    this.selectedBatch = new Set();
    this.pendingMailboxSelections = new Map();
    this.unsub = null;
  }
  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return 'MailDump'; }
  getIcon() { return 'mail'; }
  async onOpen() {
    this.presets = this.plugin.presetStore.load();
    this.currentPresetId = this.presets[0]?.id || null;
    this.unsub = this.plugin.ops.subscribe(() => this.renderStatus());
    this.render();
  }
  async onClose() { if (this.unsub) this.unsub(); }
  get currentPreset() { return this.presets.find(p => p.id === this.currentPresetId) || this.presets[0] || null; }
  savePresets() { this.plugin.presetStore.save(this.presets); }
  saveCurrentPresetWithNotice() {
    this.savePresets();
    new Notice('MailDump: пресет сохранён');
    this.plugin.appendMessageHistory('Пресет сохранён');
  }
  renameCurrentPreset() {
    const p = this.currentPreset;
    if (!p) return;
    const next = prompt('Новое имя пресета', p.name || '');
    if (next == null) return;
    const name = String(next).trim();
    if (!name) return;
    const oldName = p.name;
    p.name = name;
    if (!p.output.exportName || p.output.exportName === oldName) p.output.exportName = name;
    this.savePresets();
    this.plugin.appendMessageHistory(`Пресет переименован: ${name}`);
    this.render();
  }
  section(root, title, open = true) {
    const d = root.createEl('details', { cls: 'mail-dump-section' });
    d.open = open;
    d.createEl('summary', { text: title, cls: 'mail-dump-section-title' });
    return d.createDiv({ cls: 'mail-dump-section-body' });
  }
  render() {
    const root = this.containerEl.children[1] || this.containerEl;
    root.empty(); root.addClass('mail-dump-panel');
    this.progress = root.createDiv({ cls: 'mail-dump-progress is-hidden' });
    this.progressFill = this.progress.createDiv({ cls: 'mail-dump-progress-fill' });
    const head = root.createDiv({ cls: 'mail-dump-head' });
    head.createEl('h3', { text: `MailDump ${this.plugin.manifest?.version || ''}`.trim() });
    this.renderRun(root);
    this.renderStatusSection(root);
    this.renderPresets(root);
    this.renderCurrentPreset(root);
    this.renderMailboxesSection(root);
    this.renderFilters(root);
    this.renderCleanup(root);
    this.renderStatus();
  }
  renderStatusSection(root) {
    const box = this.section(root, 'Служебные сообщения', true);
    this.statusBox = box.createDiv({ cls: 'mail-dump-status mail-dump-status-history' });
    const actions = box.createDiv({ cls: 'mail-dump-actions' });
    const openLog = actions.createEl('button', { text: 'Открыть журнал JSON' });
    openLog.onclick = () => {
      const rel = path.join(this.plugin.settings.outputFolder || 'MailDump', RUN_LOG_FILE).replace(/\\/g, '/');
      this.app.workspace.openLinkText(rel, '', false);
    };
    const clearLog = actions.createEl('button', { text: 'Очистить журнал' });
    clearLog.onclick = () => {
      if (!confirm('Очистить _mail_dump_runs.json? Файлы выгрузок не удаляются.')) return;
      new RunLogStore(this.plugin).clear();
      this.plugin.appendMessageHistory('Журнал запусков очищен');
      this.renderStatus();
    };
  }
  renderRun(root) {
    const box = this.section(root, 'Запуск', true);
    const actions = box.createDiv({ cls: 'mail-dump-actions mail-dump-run-actions' });
    this.btnRun = actions.createEl('button', { text: '▶ Пуск', cls: 'mod-cta' });
    this.btnRun.onclick = () => this.runCurrent();
    this.btnBatch = actions.createEl('button', { text: '▶ Выбранные' });
    this.btnBatch.onclick = () => this.runBatch();
    this.btnPreflight = actions.createEl('button', { text: 'Оценить объём' });
    this.btnPreflight.onclick = () => this.preflight();
    this.btnStop = actions.createEl('button', { text: 'Стоп' });
    this.btnStop.onclick = () => this.plugin.ops.cancel();
  }
  renderPresets(root) {
    const box = this.section(root, 'Пресеты', true);
    const list = box.createDiv({ cls: 'mail-dump-preset-list' });
    for (const p of this.presets) {
      const row = list.createDiv({ cls: 'mail-dump-preset-row' + (p.id === this.currentPresetId ? ' is-active' : '') });
      const cb = row.createEl('input', { type: 'checkbox' });
      cb.checked = this.selectedBatch.has(p.id);
      cb.onchange = () => cb.checked ? this.selectedBatch.add(p.id) : this.selectedBatch.delete(p.id);
      const btn = row.createEl('button', { text: `${p.emoji || '📧'} ${p.name}` });
      btn.onclick = () => { this.currentPresetId = p.id; this.savePresets(); this.render(); };
    }
    const actions = box.createDiv({ cls: 'mail-dump-actions' });
    const add = actions.createEl('button', { text: '+ Новый' });
    add.onclick = () => { const p = createPreset(null, '📧', 'Новый пресет', 'last_7_days', [], 'Выгрузки писем'); this.presets.push(p); this.currentPresetId = p.id; this.savePresets(); this.render(); };
    const dup = actions.createEl('button', { text: 'Дублировать' });
    dup.onclick = () => { const p = this.currentPreset; if (!p) return; const copy = JSON.parse(JSON.stringify(p)); copy.id = `preset_${Date.now()}_${crypto.randomBytes(2).toString('hex')}`; copy.name += ' копия'; this.presets.push(copy); this.currentPresetId = copy.id; this.savePresets(); this.render(); };
    const rename = actions.createEl('button', { text: 'Переименовать' });
    rename.onclick = () => this.renameCurrentPreset();
    const save = actions.createEl('button', { text: 'Сохранить пресет' });
    save.onclick = () => this.saveCurrentPresetWithNotice();
    const exportBtn = actions.createEl('button', { text: 'Экспорт пресетов' });
    exportBtn.onclick = () => {
      try {
        const rel = this.plugin.presetStore.exportToFile(this.presets);
        new Notice(`MailDump: пресеты экспортированы в ${rel}`);
        this.plugin.appendMessageHistory(`Пресеты экспортированы: ${rel}`);
      } catch (e) { new Notice(`MailDump: ${e.message || e}`); }
    };
    const importBtn = actions.createEl('button', { text: 'Импорт пресетов' });
    importBtn.onclick = () => {
      const filePath = prompt('Путь к JSON-файлу пресетов. Можно указать путь относительно vault или абсолютный путь.');
      if (!filePath) return;
      try {
        this.presets = this.plugin.presetStore.importFromFile(filePath);
        this.currentPresetId = this.presets[0]?.id || null;
        this.selectedBatch.clear();
        new Notice(`MailDump: пресеты импортированы`);
        this.plugin.appendMessageHistory(`Пресеты импортированы: ${filePath}`);
        this.render();
      } catch (e) { new Notice(`MailDump: ${e.message || e}`); }
    };
    const del = actions.createEl('button', { text: 'Удалить' });
    del.onclick = () => { const p = this.currentPreset; if (!p) return; if (!confirm(`Удалить пресет «${p.name}»?`)) return; this.presets = this.presets.filter(x => x.id !== p.id); this.selectedBatch.delete(p.id); this.currentPresetId = this.presets[0]?.id || null; this.savePresets(); this.render(); };
  }
  renderCurrentPreset(root) {
    const p = this.currentPreset; if (!p) return;
    const box = this.section(root, `Текущий пресет: ${p.emoji || '📧'} ${p.name}`, true);
    addField(box, 'Название', p.name, v => { p.name = v || 'Без названия'; this.savePresets(); });
    box.createDiv({ cls: 'mail-dump-muted', text: 'Изменения в полях сохраняются сразу. Кнопка «Сохранить пресет» оставлена как явное подтверждение.' });
    addField(box, 'Эмодзи', p.emoji, v => { p.emoji = v || '📧'; this.savePresets(); });
    addField(box, 'Название файла сводки', p.output.exportName, v => { p.output.exportName = v || p.name; this.savePresets(); });
    box.createDiv({ cls: 'mail-dump-muted', text: `Сводка сохраняется в корень папки ${this.plugin.settings.outputFolder || 'MailDump'}, без подпапок и CSV.` });
    addSelect(box, 'Период', PERIOD_OPTIONS, p.period.mode, v => { p.period.mode = v; this.savePresets(); this.render(); });
    if (p.period.mode === 'custom') {
      addField(box, 'Дата с', p.period.from || formatDateFolder(resolveDateRange(p).from), v => { p.period.from = v; this.savePresets(); }, 'date');
      addField(box, 'Дата по', p.period.to || formatDateFolder(resolveDateRange(p).to), v => { p.period.to = v; this.savePresets(); }, 'date');
    } else {
      const r = resolveDateRange(p);
      box.createDiv({ cls: 'mail-dump-muted', text: `Фактический период: ${formatDateFolder(r.from)} → ${formatDateFolder(r.to)}` });
    }
    addSelect(box, 'Сортировка', SORT_OPTIONS, p.sort.by, v => { p.sort.by = v; this.savePresets(); });
    addSelect(box, 'Порядок', [['asc', 'По возрастанию'], ['desc', 'По убыванию']], p.sort.direction, v => { p.sort.direction = v; this.savePresets(); });
    const content = box.createDiv({ cls: 'mail-dump-subblock' });
    content.createEl('div', { text: 'Содержимое сводки', cls: 'mail-dump-mini-title' });
    content.createDiv({ cls: 'mail-dump-muted', text: 'M1 всегда загружает полное текстовое тело письма без ограничения символов. Неполного режима в этой сборке нет.' });
    addCheck(content, 'Кому', p.content.includeTo !== false, v => { p.content.includeTo = v; this.savePresets(); });
    addCheck(content, 'Копия', p.content.includeCc !== false, v => { p.content.includeCc = v; this.savePresets(); });
    addCheck(content, 'References', p.content.includeReferences !== false, v => { p.content.includeReferences = v; this.savePresets(); });
    addCheck(content, 'Attachments', p.content.includeAttachments !== false, v => { p.content.includeAttachments = v; this.savePresets(); });
    addSelect(content, 'Очистка текста', [['clean', 'Очищать: удалить ответы и подписи'], ['raw', 'Оставить исходный текст без очистки']], p.content.keepOriginalBody ? 'raw' : 'clean', v => { p.content.keepOriginalBody = v === 'raw'; if (p.content.keepOriginalBody) { p.content.stripHistory = false; p.content.stripSignatures = false; } else { p.content.stripHistory = true; p.content.stripSignatures = true; } this.savePresets(); this.render(); });
    if (!p.content.keepOriginalBody) {
      addCheck(content, 'Удалять цепочки переписки', p.content.stripHistory !== false, v => { p.content.stripHistory = v; this.savePresets(); this.render(); });
      if (p.content.stripHistory !== false) {
        addCheck(content, 'Оставить пересылаемые письма', p.content.keepForwarded !== false, v => { p.content.keepForwarded = v; this.savePresets(); });
        addTextarea(content, 'Маркер начала цепочки переписки', p.content.replyChainStartMarker || '', v => { p.content.replyChainStartMarker = v || ''; this.savePresets(); });
        content.createDiv({ cls: 'mail-dump-muted', text: 'Дополнительный ручной маркер. Можно вставить несколько строк, например: ----------------\nКому:. Если маркер найден, всё ниже него вырезается из тела письма.' });
      }
      addCheck(content, 'Удалять подписи', p.content.stripSignatures !== false, v => { p.content.stripSignatures = v; this.savePresets(); });
    }

    const files = box.createDiv({ cls: 'mail-dump-subblock' });
    files.createEl('div', { text: 'Файлы писем и вложения', cls: 'mail-dump-mini-title' });
    addCheck(files, 'Создавать .md файлы писем', !!p.artifacts?.saveMailNotes, v => { p.artifacts = p.artifacts || {}; p.artifacts.saveMailNotes = v; this.savePresets(); this.render(); });
    addCheck(files, 'Сохранять вложения рядом с .md письма', !!p.artifacts?.saveAttachments, v => { p.artifacts = p.artifacts || {}; p.artifacts.saveAttachments = v; if (v) p.artifacts.saveMailNotes = true; this.savePresets(); this.render(); });
    if (p.artifacts?.saveAttachments) {
      const extBox = files.createDiv({ cls: 'mail-dump-inline-checks' });
      const extSet = new Set(getEnabledAttachmentExts(p));
      for (const ext of ['txt', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx']) {
        addCheck(extBox, ext, extSet.has(ext), v => {
          const list = Array.isArray(p.artifacts.attachmentExtensions) ? p.artifacts.attachmentExtensions.map(normalizeExt).filter(Boolean) : [];
          const set = new Set(list);
          v ? set.add(ext) : set.delete(ext);
          p.artifacts.attachmentExtensions = Array.from(set);
          this.savePresets();
        });
      }
      addField(files, 'Другие расширения через запятую', p.artifacts.customAttachmentExtensions || '', v => { p.artifacts.customAttachmentExtensions = v; this.savePresets(); });
      files.createDiv({ cls: 'mail-dump-muted', text: 'Вложения сохраняются в ту же папку, что и .md письма. У письма и вложений одинаковый префикс по дате/времени письма и UID.' });
      addSelect(files, 'Группировка файлов писем', [['none', 'Без подпапок'], ['day', 'По дням'], ['week', 'По неделям'], ['month', 'По месяцам']], p.output.grouping || 'day', v => { p.output.grouping = v; this.savePresets(); });
      addField(files, 'Подпапка для файлов писем', p.output.subfolder || '', v => { p.output.subfolder = v || ''; this.savePresets(); });
    }
    this.renderAdvanced(box, p);
  }
  renderAdvanced(parent, p) {
    const box = this.section(parent, 'Расширенные настройки', false);
    const current = String(p.performance?.fetchBatchSize || this.plugin.settings.fetchBatchSize || 10);
    addSelect(box, 'Размер пакета UID', [['1', '1'], ['5', '5'], ['10', '10'], ['15', '15'], ['25', '25'], ['50', '50']], current, v => { p.performance = p.performance || {}; p.performance.fetchBatchSize = Number(v || 10); this.savePresets(); });
    box.createDiv({ cls: 'mail-dump-muted', text: 'Пакет задаёт размер обрабатываемого блока UID. Текстовые части и вложения всё равно скачиваются безопасно по MIME-part, без BODY.PEEK[] всего письма.' });
  }
  applyPendingMailboxes(p) {
    const pending = this.pendingMailboxSelections.get(p.id);
    if (!pending) return;
    p.source.mailboxes = Array.from(pending);
    this.savePresets();
    this.plugin.appendMessageHistory(`Папки пресета применены: ${p.source.mailboxes.join(', ') || 'не выбраны'}`);
  }
  async refreshAndApplyMailboxes() {
    const p = this.currentPreset;
    if (!p) return;
    this.applyPendingMailboxes(p);
    await this.loadMailboxes();
  }
  renderMailboxesSection(root) {
    const p = this.currentPreset; if (!p) return;
    if (!this.pendingMailboxSelections.has(p.id)) this.pendingMailboxSelections.set(p.id, new Set(p.source.mailboxes || []));
    const pendingSet = this.pendingMailboxSelections.get(p.id);
    const box = this.section(root, 'IMAP-папки', true);
    const actions = box.createDiv({ cls: 'mail-dump-actions' });
    const refresh = actions.createEl('button', { text: 'Обновить IMAP папки / Применить' });
    refresh.onclick = () => this.refreshAndApplyMailboxes();
    box.createDiv({ cls: 'mail-dump-muted', text: 'Галочки меняют выбор на экране. Кнопка применяет выбор к текущему пресету и обновляет список папок с сервера.' });
    const available = this.plugin.availableMailboxes || [];
    if (available.length) {
      const mb = box.createDiv({ cls: 'mail-dump-mailboxes' });
      for (const name of available) addCheck(mb, name, pendingSet.has(name), v => {
        v ? pendingSet.add(name) : pendingSet.delete(name);
        this.renderStatus();
      });
    } else {
      box.createDiv({ cls: 'mail-dump-muted', text: 'Папки пока не загружены. Нажмите «Обновить IMAP папки / Применить» или укажите имена вручную.' });
    }
    addTextarea(box, 'Папки вручную через запятую', Array.from(pendingSet).join(', '), v => {
      this.pendingMailboxSelections.set(p.id, new Set(splitTerms(v)));
    });
  }
  renderFilters(root) {
    const p = this.currentPreset; if (!p) return;
    const box = this.section(root, 'Фильтры', false);
    box.createEl('div', { text: 'Фильтры применяются локально после загрузки писем за период. Это надёжнее для русских тем, чем IMAP-поиск по кириллице.', cls: 'mail-dump-muted' });
    box.createEl('div', { text: 'Включить', cls: 'mail-dump-mini-title' });
    addField(box, 'От содержит', p.filters.include.from, v => { p.filters.include.from = v; this.savePresets(); });
    addField(box, 'Кому/копия содержит', p.filters.include.to, v => { p.filters.include.to = v; this.savePresets(); });
    addField(box, 'Тема содержит', p.filters.include.subject, v => { p.filters.include.subject = v; this.savePresets(); });
    box.createEl('div', { text: 'Исключить', cls: 'mail-dump-mini-title' });
    addField(box, 'От содержит', p.filters.exclude.from, v => { p.filters.exclude.from = v; this.savePresets(); });
    addField(box, 'Кому/копия содержит', p.filters.exclude.to, v => { p.filters.exclude.to = v; this.savePresets(); });
    addField(box, 'Тема содержит', p.filters.exclude.subject, v => { p.filters.exclude.subject = v; this.savePresets(); });
  }
  renderCleanup(root) {
    const box = this.section(root, 'Журнал / очистка', false);
    const last = new RunLogStore(this.plugin).getLastDigestRun();
    box.createDiv({ cls: 'mail-dump-muted', text: last ? `Последняя сводка: ${last.finishedAt} · ${last.presetName} · файлов: ${(last.filesCreated || []).length}` : 'Журнал пуст' });
    const actions = box.createDiv({ cls: 'mail-dump-actions' });
    const del = actions.createEl('button', { text: 'Удалить последнюю сводку' });
    del.onclick = () => { if (!confirm('Удалить последний digest-файл по журналу? Почта на сервере не затрагивается.')) return; try { const res = new CleanupService(this.plugin).deleteLastDigest(); new Notice(`Удалено файлов: ${res.deleted}`); this.render(); } catch (e) { new Notice(`MailDump: ${e.message || e}`); } };
    const clearKeep = actions.createEl('button', { text: 'Очистить выгрузки' });
    clearKeep.onclick = () => { if (!confirm('Удалить все файлы выгрузок в MailDump, но оставить служебный JSON журнала?')) return; try { const res = new CleanupService(this.plugin).deleteOutputContents({ includeServiceJson: false }); new Notice(`Удалено файлов: ${res.deletedFiles}`); this.render(); } catch (e) { new Notice(`MailDump: ${e.message || e}`); } };
    const clearFull = actions.createEl('button', { text: 'Полная очистка MailDump' });
    clearFull.onclick = () => { if (!confirm('Полностью очистить папку MailDump, включая служебные JSON? Это удалит журнал запусков.')) return; try { const res = new CleanupService(this.plugin).deleteOutputContents({ includeServiceJson: true }); new Notice(`MailDump очищен. Удалено файлов: ${res.deletedFiles}`); this.render(); } catch (e) { new Notice(`MailDump: ${e.message || e}`); } };
    box.createDiv({ cls: 'mail-dump-muted', text: 'Полная очистка удаляет и _mail_dump_runs.json. После неё история запусков начнётся заново.' });
  }
  setBusyButtons(busy) {
    for (const b of [this.btnRun, this.btnBatch, this.btnPreflight]) if (b) b.disabled = busy;
    if (this.btnStop) this.btnStop.disabled = !busy;
  }
  renderStatus() {
    const op = this.plugin.ops.active;
    const busy = !!op;
    this.setBusyButtons(busy);
    if (this.progress && this.progressFill) {
      if (!busy || op.progressMode === 'hidden') this.progress.addClass('is-hidden');
      else this.progress.removeClass('is-hidden');
      this.progressFill.style.width = op && op.progressMode === 'percent' ? `${Math.max(0, Math.min(100, Number(op.progress || 0)))}%` : '35%';
      this.progress.toggleClass('is-indeterminate', !!op && op.progressMode !== 'percent');
    }
    if (!this.statusBox) return;
    this.statusBox.empty();
    const current = this.statusBox.createDiv({ cls: 'mail-dump-status-current' });
    current.createDiv({ text: op ? (op.text || op.type) : 'Нет активной операции' });
    if (op && op.counts) current.createDiv({ cls: 'mail-dump-muted', text: Object.entries(op.counts).map(([k, v]) => `${k}: ${v}`).join(' · ') });
    if (op && op.resultPath) current.createEl('a', { text: 'Открыть сводку', attr: { href: `obsidian://open?path=${encodeURIComponent(op.resultPath)}` } });
    const history = this.plugin.messageHistory || [];
    if (history.length) {
      this.statusBox.createDiv({ cls: 'mail-dump-mini-title', text: 'История' });
      for (const item of history.slice(-Number(this.plugin.settings.messageHistoryLimit || 80)).reverse()) {
        this.statusBox.createDiv({ cls: 'mail-dump-status-line', text: `${item.time} · ${item.text}` });
      }
    }
  }
  async runCurrent() {
    const p = this.currentPreset;
    if (!p) return;
    if (!p.source.mailboxes.length) { new Notice('MailDump: выберите IMAP-папки'); return; }
    try { const res = await this.plugin.exportService.runPreset(p); new Notice(`MailDump: сводка создана`); this.render(); return res; }
    catch (e) { new Notice(`MailDump: ${e.message || e}`); this.render(); }
  }
  async runBatch() {
    const list = Array.from(this.selectedBatch).map(id => this.presets.find(p => p.id === id)).filter(Boolean);
    if (!list.length) { new Notice('MailDump: пресеты не выбраны'); return; }
    for (const p of list) {
      if (!p.source.mailboxes.length) continue;
      try { await this.plugin.exportService.runPreset(p); }
      catch (e) { new Notice(`MailDump: ${p.name}: ${e.message || e}`); break; }
    }
    this.render();
  }
  async loadMailboxes() { try { await this.plugin.exportService.loadMailboxes(); new Notice('MailDump: список IMAP-папок загружен'); this.render(); } catch (e) { new Notice(`MailDump: ${e.message || e}`); this.render(); } }
  async preflight() { const p = this.currentPreset; if (!p) return; try { const r = await this.plugin.exportService.preflight(p); new Notice(`MailDump: найдено ${r.total}`); this.render(); } catch (e) { new Notice(`MailDump: ${e.message || e}`); this.render(); } }
}

class MailDumpSettingsTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: `MailDump ${this.plugin.manifest?.version || ''}` });
    containerEl.createEl('p', { text: 'Настройки IMAP и локального хранения app-password. Интерфейс плагина русский; команды Obsidian — английские.', attr: { style: 'color: var(--text-muted);' } });
    containerEl.createEl('p', { text: 'Предупреждение: app-password хранится локально в data.json внутри папки плагина, если выбран режим хранения. Не публикуйте data.json и не добавляйте его в репозиторий.', attr: { style: 'color: var(--text-warning);' } });
    new Setting(containerEl).setName('IMAP host').addText(t => t.setValue(this.plugin.settings.imapHost).onChange(async v => { this.plugin.settings.imapHost = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName('IMAP port').addText(t => t.setValue(String(this.plugin.settings.imapPort)).onChange(async v => { this.plugin.settings.imapPort = Number(v || 993); await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName('Логин').addText(t => t.setValue(this.plugin.settings.username).onChange(async v => { this.plugin.settings.username = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName('Режим app-password').setDesc('Хранить локально, спрашивать каждый раз или держать только до перезапуска Obsidian.').addDropdown(d => d
      .addOption('store', 'Хранить в data.json')
      .addOption('ask', 'Спрашивать каждый раз')
      .addOption('session', 'Запоминать в рамках сессии')
      .setValue(this.plugin.settings.appPasswordMode || 'store')
      .onChange(async v => { this.plugin.settings.appPasswordMode = v; if (v !== 'store') this.plugin.settings.appPassword = ''; this.plugin.sessionAppPassword = ''; await this.plugin.saveSettings(); this.display(); }));
    if ((this.plugin.settings.appPasswordMode || 'store') === 'store') {
      new Setting(containerEl).setName('App-password').setDesc('Рекомендуется app-password почтового сервиса, а не основной пароль аккаунта.').addText(t => { t.inputEl.type = 'password'; t.setValue(this.plugin.settings.appPassword || '').onChange(async v => { this.plugin.settings.appPassword = v; await this.plugin.saveSettings(); }); });
    } else {
      new Setting(containerEl).setName('App-password').setDesc('В этом режиме пароль не сохраняется в data.json. Он будет запрошен при запуске операции.');
    }
    new Setting(containerEl).setName('Дополнительные адреса пользователя').setDesc('Через запятую. Нужны для incoming/outgoing и To/CC.').addText(t => t.setValue(this.plugin.settings.userAliases).onChange(async v => { this.plugin.settings.userAliases = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName('Контрольный адрес для счётчика').setDesc('Опционально. Используется только для счётчика в сводке.').addText(t => t.setValue(this.plugin.settings.keyContactEmail).onChange(async v => { this.plugin.settings.keyContactEmail = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName('Порог писем без ответа, часов').addText(t => t.setValue(String(this.plugin.settings.unansweredThresholdHours || 7)).onChange(async v => { this.plugin.settings.unansweredThresholdHours = Number(v || 7); await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName('Корневая папка выгрузки').addText(t => t.setValue(this.plugin.settings.outputFolder).onChange(async v => { this.plugin.settings.outputFolder = v || 'MailDump'; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName('Таймаут IMAP-команды, мс').setDesc('Если письмо тяжёлое или сервер отвечает медленно, увеличьте до 120000–180000. По умолчанию загружаются HEADER + текстовые MIME-части; выбранные вложения скачиваются только по разрешённым расширениям.').addText(t => t.setValue(String(this.plugin.settings.commandTimeoutMs || 60000)).onChange(async v => { this.plugin.settings.commandTimeoutMs = Number(v || 60000); await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName('Таймаут подключения, мс').addText(t => t.setValue(String(this.plugin.settings.connectTimeoutMs || 60000)).onChange(async v => { this.plugin.settings.connectTimeoutMs = Number(v || 60000); await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName('Проверять TLS-сертификат').setDesc('Для корпоративных/нестандартных окружений можно выключить.').addToggle(t => t.setValue(!!this.plugin.settings.tlsRejectUnauthorized).onChange(async v => { this.plugin.settings.tlsRejectUnauthorized = !!v; await this.plugin.saveSettings(); }));
  }
}

module.exports = class MailDumpM1Plugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.availableMailboxes = [];
    this.messageHistory = [];
    this.activeClient = null;
    this.sessionAppPassword = '';
    this.statusBarEl = this.addStatusBarItem();
    this.ops = new OperationStore(this);
    this.ops.subscribe(op => this.renderStatusBar(op));
    this.renderStatusBar(null);
    this.presetStore = new PresetStore(this);
    this.exportService = new ExportService(this);
    this.registerView(VIEW_TYPE, leaf => new MailDumpView(leaf, this));
    this.addSettingTab(new MailDumpSettingsTab(this.app, this));
    this.addCommand({ id: 'open-maildump-panel', name: 'Open MailDump panel', callback: () => this.openPanel() });
    this.addCommand({ id: 'stop-maildump-operation', name: 'Stop current MailDump operation', callback: () => this.ops.cancel() });
    this.addRibbonIcon('mail', 'MailDump', () => this.openPanel());
  }
  onunload() { this.ops.cancel(); this.app.workspace.detachLeavesOfType(VIEW_TYPE); }
  appendMessageHistory(text, op) {
    const msg = String(text || '').trim();
    if (!msg) return;
    const last = this.messageHistory[this.messageHistory.length - 1];
    const now = new Date();
    const stamp = formatDateTime(now).split(' ')[1];
    if (last && last.text === msg) return;
    this.messageHistory.push({ time: stamp, type: op?.type || '', text: msg });
    const limit = Math.max(20, Number(this.settings.messageHistoryLimit || 80));
    if (this.messageHistory.length > limit) this.messageHistory.splice(0, this.messageHistory.length - limit);
  }
  async loadSettings() {
    const raw = await this.loadData();
    this.dataCache = raw && typeof raw === 'object' ? raw : {};
    const sourceSettings = this.dataCache.settings && typeof this.dataCache.settings === 'object' ? this.dataCache.settings : this.dataCache;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, sourceSettings || {});
    if (this.settings.password && !this.settings.appPassword) {
      this.settings.appPassword = this.settings.password;
      delete this.settings.password;
    }
    delete this.settings.password;
    this.dataCache.settings = this.settings;
    if (!Array.isArray(this.dataCache.presets)) this.dataCache.presets = Array.isArray(this.dataCache.presets) ? this.dataCache.presets : undefined;
    await this.persistData();
  }
  async saveSettings() {
    this.dataCache = this.dataCache || {};
    this.dataCache.settings = this.settings;
    await this.persistData();
  }
  async persistData() {
    this.dataCache = this.dataCache || {};
    if (!this.dataCache.settings) this.dataCache.settings = this.settings || DEFAULT_SETTINGS;
    await this.saveData(this.dataCache);
  }
  async resolveAppPassword() {
    const mode = this.settings.appPasswordMode || 'store';
    if (mode === 'store') {
      if (!this.settings.appPassword) throw new Error('App-password не задан в настройках');
      return this.settings.appPassword;
    }
    if (mode === 'session' && this.sessionAppPassword) return this.sessionAppPassword;
    const value = prompt('MailDump: введите app-password для IMAP');
    if (!value) throw new Error('App-password не введён');
    if (mode === 'session') this.sessionAppPassword = value;
    return value;
  }
  renderStatusBar(op) {
    if (!this.statusBarEl) return;
    if (!op) { this.statusBarEl.setText('MailDump: idle'); return; }
    const prefix = op.status === 'cancelling' ? 'stopping' : op.type;
    const progress = op.progressMode === 'percent' ? ` ${Math.max(0, Math.min(100, Number(op.progress || 0)))}%` : '';
    this.statusBarEl.setText(`MailDump: ${prefix}${progress}`);
  }
  abortActiveClient() { try { if (this.activeClient) this.activeClient.abort(); } catch {} }
  async openPanel() {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) { leaf = this.app.workspace.getRightLeaf(false); await leaf.setViewState({ type: VIEW_TYPE, active: true }); }
    this.app.workspace.revealLeaf(leaf);
  }
};
