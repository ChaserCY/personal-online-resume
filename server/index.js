'use strict';

/**
 * 简历站的后端。只做三件事：
 *   1. 校验管理员密码，签发 token
 *   2. 把后台的改动原子地写进 web/data/data.json
 *   3. 接收图片上传，落盘到 web/uploads/
 *
 * 静态文件由 nginx 直接托管，请求不经过这里；只有 /api/* 会转发过来。
 * 本地开发时这个进程也会顺便托管 web/，所以 npm start 就能看到完整站点。
 */

const crypto = require('crypto');
const fsp = require('fs/promises');
const path = require('path');
const express = require('express');
const { extractRows, parseResume } = require('./resume-parse.js');

// quiet: 关掉 dotenv 自带的推广横幅，让 journalctl 里只有我们自己的日志
require('dotenv').config({ path: path.join(__dirname, '.env'), quiet: true });

// ---------- 配置 ----------

const PORT = Number(process.env.PORT || 3001);
const HOST = process.env.HOST || '127.0.0.1';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET || ADMIN_PASSWORD;
const TOKEN_TTL_MS = Number(process.env.TOKEN_TTL_HOURS || 168) * 3600 * 1000;

if (!ADMIN_PASSWORD) {
  console.error('[fatal] 没有设置 ADMIN_PASSWORD。请复制 .env.example 为 .env 并填写密码。');
  process.exit(1);
}
if (!process.env.SESSION_SECRET) {
  console.warn('[warn] 未设置 SESSION_SECRET，正在用 ADMIN_PASSWORD 派生签名密钥。');
  console.warn('[warn] 建议在 .env 里单独设一个随机串，改密码时才不会把所有登录态踢掉。');
}

const WEB_DIR = path.resolve(__dirname, '..', 'web');
const DATA_FILE = path.join(WEB_DIR, 'data', 'data.json');
const BACKUP_FILE = path.join(__dirname, 'backups', 'data.json.bak');
const UPLOAD_DIR = path.join(WEB_DIR, 'uploads');

const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_MB || 5) * 1024 * 1024;
const MAX_PDF_BYTES = Number(process.env.MAX_PDF_MB || 10) * 1024 * 1024;

// 白名单。不在这里的类型一律拒绝 —— 尤其是 image/svg+xml 和 text/html，
// 它们能携带脚本，传上去就是一个存储型 XSS。
const ALLOWED_TYPES = {
  'image/png': { ext: 'png', max: MAX_UPLOAD_BYTES },
  'image/jpeg': { ext: 'jpg', max: MAX_UPLOAD_BYTES },
  'image/gif': { ext: 'gif', max: MAX_UPLOAD_BYTES },
  'image/webp': { ext: 'webp', max: MAX_UPLOAD_BYTES },
  'application/pdf': { ext: 'pdf', max: MAX_PDF_BYTES },
};

// ---------- token ----------
// 无状态签名 token：服务重启后依然有效，不用重新登录。
// 格式 <过期时间戳>.<HMAC 签名>

const sign = (exp) =>
  crypto.createHmac('sha256', SESSION_SECRET).update(String(exp)).digest('base64url');

function issueToken() {
  const exp = Date.now() + TOKEN_TTL_MS;
  return `${exp}.${sign(exp)}`;
}

function verifyToken(token) {
  if (typeof token !== 'string') return false;
  const [expStr, sig] = token.split('.');
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  if (!sig) return false;
  const expected = sign(exp);
  if (sig.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

// 密码也走定长比较，避免用响应时间猜出密码长度
function passwordMatches(input) {
  const a = crypto.createHash('sha256').update(String(input ?? '')).digest();
  const b = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

// ---------- 登录限流 ----------
// 内存计数即可：单管理员站点，重启清零无所谓。

const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;
const attempts = new Map();

function isLockedOut(ip) {
  const rec = attempts.get(ip);
  if (!rec || rec.resetAt < Date.now()) return false;
  return rec.count >= MAX_ATTEMPTS;
}

function recordFailure(ip) {
  const now = Date.now();
  const rec = attempts.get(ip);
  if (!rec || rec.resetAt < now) attempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
  else rec.count += 1;
}

// ---------- 落盘 ----------

async function writeDataFile(payload) {
  const json = JSON.stringify(payload, null, 2) + '\n';
  await fsp.mkdir(path.dirname(DATA_FILE), { recursive: true });

  // 留一份上一版，改坏了可以直接 cp 回来
  try {
    await fsp.mkdir(path.dirname(BACKUP_FILE), { recursive: true });
    await fsp.copyFile(DATA_FILE, BACKUP_FILE);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }

  // 先写临时文件再 rename：rename 是原子的，
  // 访客不会读到只写了一半的 data.json。
  const tmp = `${DATA_FILE}.tmp`;
  await fsp.writeFile(tmp, json, 'utf8');
  await fsp.rename(tmp, DATA_FILE);
  return Buffer.byteLength(json);
}

/**
 * 首次启动时把 data.seed.json 复制成 data.json。
 *
 * data.json 是运行时的内容，不进 git，所以刚 clone 下来的仓库里没有它。
 * 没有它前台就是一具空壳（没有名字、没有作品），用户会以为项目坏了。
 * 这里补一份示例内容，让「clone 完直接 npm start」就能看到一个完整站点，
 * 之后后台一保存就覆盖掉了。
 */
async function ensureDataFile() {
  const SEED_FILE = path.join(WEB_DIR, 'data', 'data.seed.json');
  try {
    await fsp.access(DATA_FILE);
    return;
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  try {
    await fsp.mkdir(path.dirname(DATA_FILE), { recursive: true });
    await fsp.copyFile(SEED_FILE, DATA_FILE);
    console.log('[resume] 没有 data.json，已从 data.seed.json 生成一份示例内容');
  } catch (e) {
    // 生成失败不致命：后台第一次保存时 writeDataFile 会自己建出来
    console.error('[warn] 生成初始 data.json 失败（后台保存时会自动创建）:', e.message);
  }
}

// ---------- 应用 ----------

const app = express();
app.disable('x-powered-by');
// nginx 在 127.0.0.1 上转发，信任它带来的 X-Forwarded-For，限流才拿得到真实 IP
app.set('trust proxy', 'loopback');
// 上传走 base64，体积比原文件大约 1/3，所以这里要留够余量：
// 10MB 的 PDF 编码后约 13.3MB。改 MAX_PDF_MB 时记得同步这里和 nginx 的 client_max_body_size。
app.use(express.json({ limit: '20mb' }));

function requireAuth(req, res, next) {
  const header = req.get('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!verifyToken(token)) return res.status(401).json({ error: 'unauthorized' });
  next();
}

app.post('/api/login', (req, res) => {
  const ip = req.ip || 'unknown';
  if (isLockedOut(ip)) {
    return res.status(429).json({ error: 'too many attempts, try again later' });
  }
  if (!passwordMatches(req.body && req.body.password)) {
    recordFailure(ip);
    return res.status(401).json({ error: 'invalid password' });
  }
  attempts.delete(ip);
  res.json({ token: issueToken(), expiresIn: TOKEN_TTL_MS });
});

app.get('/api/session', requireAuth, (_req, res) => res.json({ valid: true }));

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.put('/api/data', requireAuth, async (req, res) => {
  const payload = req.body;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return res.status(400).json({ error: 'body must be a JSON object' });
  }
  // 挡住明显写坏的请求，免得把线上数据覆盖成空壳
  if (payload.profile !== undefined && (typeof payload.profile !== 'object' || payload.profile === null)) {
    return res.status(400).json({ error: 'profile must be an object' });
  }
  if (payload.games !== undefined && !Array.isArray(payload.games)) {
    return res.status(400).json({ error: 'games must be an array' });
  }
  if (payload.videos !== undefined && !Array.isArray(payload.videos)) {
    return res.status(400).json({ error: 'videos must be an array' });
  }

  try {
    const bytes = await writeDataFile(payload);
    res.json({ ok: true, bytes });
  } catch (e) {
    console.error('[error] 写入 data.json 失败:', e);
    res.status(500).json({ error: 'failed to write data file' });
  }
});

app.post('/api/upload', requireAuth, async (req, res) => {
  const dataUrl = req.body && req.body.dataUrl;
  const match = typeof dataUrl === 'string' && dataUrl.match(/^data:([a-z0-9.+/-]+);base64,(.+)$/i);
  if (!match) {
    return res.status(400).json({ error: 'expected a base64 data URL' });
  }
  const mime = match[1].toLowerCase();
  const rule = ALLOWED_TYPES[mime];
  if (!rule) {
    return res.status(415).json({ error: `unsupported type: ${mime}` });
  }
  const buf = Buffer.from(match[2], 'base64');
  if (buf.length > rule.max) {
    return res.status(413).json({ error: `file exceeds ${rule.max / 1024 / 1024}MB` });
  }

  const name = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${rule.ext}`;
  try {
    await fsp.mkdir(UPLOAD_DIR, { recursive: true });
    await fsp.writeFile(path.join(UPLOAD_DIR, name), buf);
  } catch (e) {
    console.error('[error] 写入上传文件失败:', e);
    return res.status(500).json({ error: 'failed to store file' });
  }
  // 相对路径：站点挂在域名根目录还是子路径都能用
  res.json({ url: `./uploads/${name}` });
});

// 解析已上传的简历 PDF，返回一份「补丁」。
// 这里只负责认字，不碰 data.json —— 合并和保存都走 PUT /api/data 那条老路，
// 免得出现第二个写数据的地方。
app.post('/api/resume/parse', requireAuth, async (req, res) => {
  const url = req.body && req.body.url;
  if (typeof url !== 'string' || !url) {
    return res.status(400).json({ error: 'expected { url }' });
  }
  // 只认自己 uploads 目录下的文件，别让它变成任意文件读取
  const name = path.basename(url);
  if (!/^[\w.-]+\.pdf$/i.test(name)) {
    return res.status(400).json({ error: 'not a pdf in uploads' });
  }
  const file = path.join(UPLOAD_DIR, name);

  let buf;
  try {
    buf = await fsp.readFile(file);
  } catch (e) {
    return res.status(404).json({ error: 'pdf not found' });
  }

  try {
    const rows = await extractRows(buf);
    const { patch, report, warnings } = parseResume(rows);
    if (!report.length) {
      return res.status(422).json({
        error: 'no resume sections recognized',
        warnings,
        sample: rows.slice(0, 8).map(r => r.text),
      });
    }
    console.log(`[resume] 解析 ${name}：${report.join('、')}`);
    res.json({ patch, report, warnings });
  } catch (e) {
    console.error('[error] 解析 PDF 失败:', e);
    res.status(500).json({ error: 'failed to parse pdf: ' + e.message });
  }
});

// 本地开发用：生产环境这些静态文件由 nginx 直接发，不会走到这里
app.use(express.static(WEB_DIR, { extensions: ['html'] }));

ensureDataFile().then(() => {
  app.listen(PORT, HOST, () => {
    console.log(`[resume] API 监听 http://${HOST}:${PORT}`);
    console.log(`[resume] 数据文件 ${DATA_FILE}`);
    console.log(`[resume] 静态目录 ${WEB_DIR}`);
  });
});
