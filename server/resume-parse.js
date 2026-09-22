// 把简历 PDF 还原成站点的数据结构。
//
// 用 MuPDF（WASM 版）而不是 pdf.js：这份简历里的加粗字体没有可用的 ToUnicode
// 映射，pdf.js 会把数字统统解析成 \u0000 —— 邮箱变成 someone@.com、
// 列表编号整段消失；MuPDF 会回退到字体自带的 cmap，能正确还原。
// 另外 MuPDF 也不会把「面」解析成康熙部首「⾯」。
//
// 设计原则：**只覆盖解析成功的字段**。
// 简历排版千变万化，任何一处认不出来都不该把线上已有的内容清空，
// 所以每个字段都是「认出来了才写」，认不出来就原样保留。

const SECTION_HEADINGS = [
  '教育背景', '在校经历', '校园经历', '项目经历', '项目经验', '个人技能',
  '专业技能', '技能特长', '实习经历', '工作经历', '荣誉奖项', '获奖情况',
  '自我评价', '个人信息', '研究方向',
];

// 「2024-09 至 2028-06」和「2025-09 至今」都要认。
// 注意「至今」不能写成可选项里的「至今」—— 连接符已经把「至」吃掉了，
// 只剩一个「今」，所以这里只匹配「今」，输出时再补回去。
const DATE_RANGE = /(\d{4}[.\-/]\d{1,2})\s*(?:至|[-~—])\s*(\d{4}[.\-/]\d{1,2}|今)/;
const fmtRange = (m) => (m[2] === '今' ? `${m[1]} 至今` : `${m[1]} 至 ${m[2]}`);

// ---------------------------------------------------------------- 版面还原

/**
 * 读 PDF，返回按视觉顺序排好的行。
 * mupdf 是 ESM + 顶层 await 的包，CommonJS 里只能动态 import。
 */
async function extractRows(buffer) {
  const mupdf = await import('mupdf');
  const m = mupdf.default ?? mupdf;
  const doc = m.Document.openDocument(new Uint8Array(buffer), 'application/pdf');
  try {
    return toRows(doc);
  } finally {
    doc.destroy?.();
  }
}

/**
 * 把 MuPDF 的 structured text 拍平成「按视觉顺序排列的逻辑行」。
 * 同一 y 上的多个片段（比如「学校 | 学院 | 专业 | 起止时间」）会拼成一行。
 */
function toRows(doc) {
  const rows = [];
  for (let p = 0; p < doc.countPages(); p++) {
    const st = doc.loadPage(p).toStructuredText('preserve-whitespace');
    const json = JSON.parse(st.asJSON());
    st.destroy?.();

    for (const block of json.blocks || []) {
      for (const line of block.lines || []) {
        const text = (line.text ?? '').replace(/\s+/g, ' ').trim();
        if (!text) continue;
        const y = line.bbox.y;
        const prev = rows[rows.length - 1];
        // 容差 2pt：同一行的片段 y 会有零点几的抖动，正常行距是 14pt 左右
        if (prev && prev.page === p && Math.abs(prev.y - y) <= 2) {
          prev.parts.push({ x: line.bbox.x, text });
          prev.y = Math.min(prev.y, y);
        } else {
          rows.push({ page: p, y, parts: [{ x: line.bbox.x, text }] });
        }
      }
    }
  }

  for (const row of rows) {
    row.parts.sort((a, b) => a.x - b.x);
    row.x = row.parts[0].x;
    row.text = row.parts.map(s => s.text).join(' | ').replace(/\s*\|\s*/g, ' | ').trim();
  }
  rows.sort((a, b) => a.page - b.page || a.y - b.y);
  return rows;
}

/** 章节标题：字号大、单独占一行、且贴在左边缘的缩进位 */
function isHeading(row) {
  if (row.text.includes('：') || row.text.includes('|')) return false;
  if (row.text.length > 6) return false;
  return SECTION_HEADINGS.some(h => row.text === h) || (row.x > 30 && row.x < 55);
}

function splitSections(rows) {
  const sections = { _head: [] };
  let current = '_head';
  for (const row of rows) {
    if (isHeading(row)) {
      current = row.text;
      sections[current] = sections[current] || [];
    } else {
      (sections[current] = sections[current] || []).push(row);
    }
  }
  return sections;
}

// ---------------------------------------------------------------- 字段解析

const pick = (text, re) => {
  const m = text.match(re);
  return m ? m[1].trim() : '';
};

/** 抬头区：姓名、求职意向、联系方式 */
function parseHead(rows) {
  const flat = rows.map(r => r.text).join('\n');
  const out = { target: {}, contact: {}, social: [] };

  const nameRow = rows.find(r => /^[一-龥]{2,4}(\s|$)/.test(r.text) && !r.text.includes('：'));
  if (nameRow) out.name = nameRow.text.split(/[\s|]/)[0];

  const pos = pick(flat, /期望职位[：:]\s*([^\s|]+)/);
  const city = pick(flat, /期望地点[：:]\s*([^\s|]+)/);
  const salary = pick(flat, /期望薪资[：:]\s*([^\s|]+)/);
  const type = pick(flat, /求职状态[：:]\s*([^\s|]+)/);
  if (pos) out.target.position = pos;
  if (city) out.target.city = city;
  if (salary) out.target.salary = salary;
  if (type) out.target.type = type;

  // 同一行的字段被我用「 | 」拼过，所以分隔符里要允许竖线
  const phone = pick(flat, /(?:手机|电话)[：:\s|]*(\d{11})/);
  const email = pick(flat, /([\w.+-]+@[\w-]+\.[\w.]+)/);
  const qq = pick(flat, /QQ[：:\s|]*(\d{5,12})/);
  const wechat = pick(flat, /微信[：:\s|]*([\w-]{4,})/);
  if (phone) out.contact.phone = phone;
  if (email) out.contact.email = email;
  if (phone) out.social.push({ name: 'Phone', url: 'tel:' + phone });
  if (email) out.social.push({ name: 'Email', url: 'mailto:' + email });
  if (qq) out.social.push({ name: 'QQ', url: qq });
  if (wechat && wechat !== phone) out.social.push({ name: 'WeChat', url: wechat });

  // 「20岁 男」这类个人标签，用来拼教育背景卡片
  const age = pick(flat, /(\d{1,2}\s*岁)/);
  if (age) out.age = age.replace(/\s+/g, '');
  out.status = type;
  return out;
}

/** 教育背景：第一行是「学校 | 学院 | 专业 | 学历 | 起止」，后面可能有课程行 */
function parseEducation(rows) {
  const first = rows.find(r => r.text.includes('|') || DATE_RANGE.test(r.text));
  if (!first) return null;
  const parts = first.text.split('|').map(s => s.trim()).filter(Boolean);
  const dates = first.text.match(DATE_RANGE);
  const rest = parts.filter(p => !DATE_RANGE.test(p));

  const school = rest[0] || '';
  const tail = rest.slice(1);
  // 「计算机与软件学院」「网络工程」「本科」三选二，靠关键词认
  const college = tail.find(p => /学院|系$/.test(p)) || '';
  const degree = tail.find(p => /^(本科|硕士|研究生|博士|大专|专科)/.test(p)) || '';
  const major = tail.find(p => p !== college && p !== degree) || '';

  const courses = rows
    .filter(r => /相关课程|主修课程|课程/.test(r.text))
    .map(r => r.text.replace(/^.*?课程\s*\|?\s*/, '').trim())
    .filter(Boolean)[0] || '';

  if (!school) return null;
  return {
    school,
    college,
    major,
    degree,
    year: dates ? fmtRange(dates) : '',
    courses,
  };
}

/** 在校经历：组织 / 职位 / 起止 + 若干描述行 */
function parseActivities(rows) {
  const meta = rows.find(r => DATE_RANGE.test(r.text) && !/相关课程/.test(r.text));
  if (!meta) return [];
  const parts = meta.text.split('|').map(s => s.trim()).filter(Boolean);
  const dates = meta.text.match(DATE_RANGE);
  const org = parts[0] || '';
  const position = parts.find(p => p !== org && !DATE_RANGE.test(p)) || '';

  // 简历里这几行本来就是各自独立的句子，接起来时补个句号，
  // 否则会出现「并合作开发组队参加过」这种连读
  let desc = '';
  for (const r of rows) {
    if (r === meta || isHeading(r) || r.text.length <= 6) continue;
    if (desc && !/[。！？；，、]$/.test(desc)) desc += '。';
    desc += r.text;
  }
  if (!org) return [];
  return [{
    organization: org,
    position,
    time: dates ? fmtRange(dates) : '',
    description: desc,
  }];
}

/** 项目经历：每条以「标题 | 角色 | 起止」开头，后面跟 背景/技术栈/编号条目 */
function parseProjects(rows) {
  const projects = [];
  let cur = null;
  let pending = ''; // 上一行没写完的续行

  const flush = () => {
    if (pending && cur) {
      const last = cur.bullets.length ? cur.bullets : cur.lines;
      if (last.length) last[last.length - 1] += pending;
      pending = '';
    }
  };

  for (const row of rows) {
    const meta = row.text.match(DATE_RANGE);
    const looksLikeTitle = meta && row.text.includes('|') && row.text.indexOf('|') < row.text.indexOf(meta[0]);

    if (looksLikeTitle) {
      flush();
      const parts = row.text.split('|').map(s => s.trim()).filter(Boolean);
      cur = {
        name: parts[0],
        role: parts.find(p => p !== parts[0] && !DATE_RANGE.test(p)) || '',
        time: fmtRange(meta),
        background: '',
        tech: [],
        bullets: [],
        lines: [],
      };
      projects.push(cur);
      continue;
    }
    if (!cur) continue;

    const bg = row.text.match(/^背景[：:]\s*(.+)$/);
    const tech = row.text.match(/^技术栈[：:]\s*(.+)$/);
    const bullet = row.text.match(/^\d+[.、]\s*(.+)$/);

    if (bg) { flush(); cur.background = bg[1].trim(); }
    else if (tech) {
      flush();
      cur.tech = tech[1].split(/[,，、]/).map(s => s.trim()).filter(Boolean);
    } else if (bullet) { flush(); cur.bullets.push(bullet[1].trim()); }
    else if (cur.bullets.length) pending += row.text;
    else if (cur.background && !cur.tech.length && !cur.bullets.length) cur.background += row.text;
    else cur.lines.push(row.text);
  }
  flush();
  return projects;
}

/** 个人技能：形如「1.分类：说明」，说明可能折行 */
function parseSkills(rows) {
  const skills = {};
  let current = null;
  for (const row of rows) {
    const m = row.text.match(/^\d+[.、]\s*([^：:]{2,10})[：:]\s*(.*)$/);
    if (m) {
      current = m[1].trim();
      skills[current] = m[2].trim();
    } else if (current) {
      // 折行的续写：中文之间不加空格，中英之间补一个
      const prev = skills[current];
      const glue = /[一-龥]$/.test(prev) && /^[一-龥]/.test(row.text) ? '' : ' ';
      skills[current] = prev + glue + row.text;
    }
  }
  return skills;
}

// ---------------------------------------------------------------- 组装

/** 把项目的一条条 bullet 拼成卡片正文，编号统一换成圆点，跟手写的风格保持一致 */
function projectBody(p) {
  const lines = [];
  if (p.background) lines.push(p.background);
  if (p.bullets.length) {
    if (lines.length) lines.push('');
    for (const b of p.bullets) lines.push('• ' + b);
  }
  return lines.join('\n').trim();
}

/** 标题归一化：只取括号前的部分，方便「星轨回响(联机版)」对上「星轨回响 (多人合作射击)」 */
const titleKey = (s) => (s || '')
  .split(/[(（]/)[0]
  .replace(/[\s\-_·]/g, '')
  .toLowerCase();

/**
 * @returns {{patch: object, report: string[], warnings: string[]}}
 *   patch 只包含解析成功的字段，调用方合并时要跳过 videos。
 */
function parseResume(rows) {
  const report = [];
  const warnings = [];
  const sections = splitSections(rows);

  const head = parseHead(sections._head || []);
  const education = parseEducation(sections['教育背景'] || []);
  const activities = parseActivities(sections['在校经历'] || sections['校园经历'] || []);
  const projects = parseProjects(sections['项目经历'] || sections['项目经验'] || []);
  const skills = parseSkills(sections['个人技能'] || sections['专业技能'] || []);

  const patch = { profile: {}, resume: {} };

  if (head.name) patch.profile.name = head.name;
  if (head.target.position) patch.profile.title = head.target.position;
  if (head.social.length) patch.profile.socialLinks = head.social;

  if (education) {
    patch.resume.education = [{
      school: education.school,
      degree: education.degree,
      major: education.major,
      year: education.year,
      courses: education.courses,
    }];
    report.push('教育背景');
  } else {
    warnings.push('没认出「教育背景」章节');
  }

  if (activities.length) {
    patch.resume.activities = activities;
    report.push('在校经历');
  }

  if (projects.length) {
    patch.resume.projects = projects.map(p => ({
      name: p.name,
      role: p.role,
      time: p.time,
      description: projectBody(p),
      // 顺带带上，前台拿它去刷新同名作品卡片的技术标签
      tech: p.tech,
    }));
    report.push(`项目经历（${projects.length} 个）`);
  } else {
    warnings.push('没认出「项目经历」章节');
  }

  if (Object.keys(skills).length) {
    patch.profile.skills = skills; // 只有 note，标签要跟线上已有的合并，见 mergeSkills
    report.push(`个人技能（${Object.keys(skills).length} 类）`);
  } else {
    warnings.push('没认出「个人技能」章节');
  }

  const target = head.target;
  if (Object.keys(target).length) {
    patch.resume.target = target;
    report.push('求职意向');
  }
  if (Object.keys(head.contact).length) {
    patch.resume.contact = head.contact;
    report.push('联系方式');
  }

  // 「关于我」的三张卡片直接用解析出来的段落拼，保持和手写时一样的结构
  const about = [];
  if (education) {
    const bits = [education.school, education.college, education.major && education.major + '专业']
      .filter(Boolean).join(' ');
    // 「2024-09 至 2028-06 本科在读」太占地方，卡片上只要年份区间
    const years = education.year.match(/\d{4}/g) || [];
    const yearBit = (years.length >= 2 ? `${years[0]}-${years[1]}` : years[0] || '')
      + (education.degree ? ` ${education.degree}在读` : '');
    const tail = [yearBit.trim(), head.age, head.status].filter(Boolean).join(' | ');
    about.push(`教育背景：${bits}，${tail}`.replace(/，$/, ''));
  }
  if (projects.length) {
    const p = projects[0];
    about.push(`最新项目：${p.name} —— ${p.background}`.trim());
  }
  if (activities.length) {
    const a = activities[0];
    about.push(`在校经历：${a.organization}${a.position ? a.position : ''}${a.time ? `（${a.time}）` : ''}，${a.description}`);
  }
  if (about.length) {
    patch.profile.about = about;
    report.push('关于我');
  }

  return { patch, report, warnings, projects, skills, education, activities };
}

module.exports = { extractRows, parseResume, toRows, titleKey, SECTION_HEADINGS };
