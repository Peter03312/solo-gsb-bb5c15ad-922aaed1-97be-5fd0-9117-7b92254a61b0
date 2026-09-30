'use strict';

/**
 * SRT 解析与校验。
 * 解析为严格模式：序号必须从 1 连续、时间码格式严格、时间合法、每块文本非空。
 * 任何错误都会被收集并附带行号，导入时整份拒绝。
 */

const TIME_RE =
  /^(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2}),(\d{3})$/;

function toMs(h, m, s, ms) {
  return h * 3600000 + m * 60000 + s * 1000 + ms;
}

function pad(n, w) {
  return String(n).padStart(w, '0');
}

function formatTimecode(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const milli = ms % 1000;
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(milli, 3)}`;
}

function parseTimecodeLine(line) {
  const m = TIME_RE.exec(line);
  if (!m) return null;
  const nums = m.slice(1).map(Number);
  const [h1, m1, s1, ms1, h2, m2, s2, ms2] = nums;
  if (m1 > 59 || s1 > 59 || m2 > 59 || s2 > 59) return null;
  const start = toMs(h1, m1, s1, ms1);
  const end = toMs(h2, m2, s2, ms2);
  return { start, end };
}

/**
 * @returns {{segments: Array<{ord:number,start_ms:number,end_ms:number,text:string}>, errors: Array<{line:number,message:string}>}}
 */
function parseSrt(raw) {
  const errors = [];
  const text = raw.replace(/^﻿/, ''); // 去 BOM
  // 统一换行；记录物理行号（以原始 \n 计数，\r 单独剔除）
  const normalized = text.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  // 末尾换行产生的空串属于正常文件结尾
  while (lines.length && lines[lines.length - 1] === '') lines.pop();

  const segments = [];

  if (lines.length === 0) {
    errors.push({ line: 1, message: '文件为空，无法解析任何字幕片段' });
    return { segments, errors };
  }

  let i = 0;
  let expectedSeq = 1;

  while (i < lines.length) {
    // 跳过块间空行（容忍多余空行，不报错）
    while (i < lines.length && lines[i].trim() === '') i++;
    if (i >= lines.length) break;

    const blockStartLine = i + 1; // 1-based 物理行号

    // 1) 序号行
    const seqLine = lines[i].trim();
    if (!/^\d+$/.test(seqLine)) {
      errors.push({
        line: blockStartLine,
        message: `第 ${blockStartLine} 行应为数字序号，实际为 "${lines[i]}"`,
      });
      i = resync(lines, i);
      continue;
    }
    const seq = Number(seqLine);
    if (seq !== expectedSeq) {
      errors.push({
        line: blockStartLine,
        message: `第 ${blockStartLine} 行序号应为 ${expectedSeq}，实际为 ${seq}（序号必须从 1 起且连续）`,
      });
    }
    i++;

    // 2) 时间码行
    if (i >= lines.length || lines[i].trim() === '') {
      errors.push({
        line: blockStartLine,
        message: `序号 ${seq}（第 ${blockStartLine} 行）之后缺少时间码行`,
      });
      i = resync(lines, i);
      continue;
    }
    const tcLine = lines[i].trim();
    const tc = parseTimecodeLine(tcLine);
    if (!tc) {
      errors.push({
        line: i + 1,
        message: `第 ${i + 1} 行时间码格式错误："${lines[i]}"，正确格式示例 00:00:01,000 --> 00:00:03,500`,
      });
      i = resync(lines, i);
      continue;
    }
    i++;

    // 3) 文本行（至少一行，直到空行或文件结束）
    const textLines = [];
    while (i < lines.length && lines[i].trim() !== '') {
      textLines.push(lines[i].replace(/[\t ]+$/g, ''));
      i++;
    }
    if (textLines.length === 0 || textLines.every((t) => t.trim() === '')) {
      errors.push({
        line: i + 1,
        message: `序号 ${seq}（第 ${blockStartLine} 行）没有字幕文本内容`,
      });
      // 该块的序号与时间码头已被消费，序号照常推进，避免重同步后产生级联误报
      expectedSeq++;
      i = resync(lines, i);
      continue;
    }

    const seg = {
      ord: expectedSeq,
      start_ms: tc.start,
      end_ms: tc.end,
      text: textLines.join('\n'),
    };
    segments.push(seg);

    if (tc.start >= tc.end) {
      errors.push({
        line: blockStartLine + 1,
        message: `序号 ${seq}：起点 ${formatTimecode(tc.start)} 必须早于终点 ${formatTimecode(tc.end)}`,
      });
    }

    expectedSeq++;
  }

  // 重叠检查（按文件顺序，相邻首尾相等不算重叠）
  for (let k = 1; k < segments.length; k++) {
    const prev = segments[k - 1];
    const cur = segments[k];
    if (cur.start_ms < prev.end_ms) {
      errors.push({
        line: 1,
        message: `序号 ${cur.ord} 的起点与序号 ${prev.ord} 的时间区间重叠（${formatTimecode(prev.end_ms)} 之后才应开始）`,
      });
    }
  }

  return { segments, errors };
}

/** 出错后重新同步到下一个空行之后，尽量收集更多错误 */
function resync(lines, i) {
  while (i < lines.length && lines[i].trim() !== '') i++;
  while (i < lines.length && lines[i].trim() === '') i++;
  return i;
}

/** 对分支片段做导出前校验，返回问题列表 */
function validateSegments(segs) {
  const issues = [];
  segs.forEach((s, idx) => {
    const pos = idx + 1;
    if (!Number.isFinite(s.start_ms) || s.start_ms < 0) {
      issues.push({ ord: pos, message: `第 ${pos} 条：起点时间不是非负数` });
    }
    if (!Number.isFinite(s.end_ms) || s.end_ms < 0) {
      issues.push({ ord: pos, message: `第 ${pos} 条：终点时间不是非负数` });
    }
    if (
      Number.isFinite(s.start_ms) &&
      Number.isFinite(s.end_ms) &&
      s.start_ms >= s.end_ms
    ) {
      issues.push({
        ord: pos,
        message: `第 ${pos} 条：起点 ${formatTimecode(s.start_ms)} 必须早于终点 ${formatTimecode(s.end_ms)}`,
      });
    }
    const txt = (s.text || '').replace(/\s/g, '');
    if (txt === '') {
      issues.push({ ord: pos, message: `第 ${pos} 条：字幕文本为空` });
    }
  });

  const sorted = segs
    .map((s, idx) => ({ s, pos: idx + 1 }))
    .filter(({ s }) => Number.isFinite(s.start_ms) && s.start_ms >= 0);
  for (let k = 1; k < sorted.length; k++) {
    const prev = sorted[k - 1].s;
    const cur = sorted[k].s;
    const curPos = sorted[k].pos;
    const prevPos = sorted[k - 1].pos;
    if (Number.isFinite(cur.end_ms) && cur.start_ms < prev.end_ms) {
      issues.push({
        ord: curPos,
        message: `第 ${curPos} 条与第 ${prevPos} 条时间重叠（起点 ${formatTimecode(cur.start_ms)} 早于上一条终点 ${formatTimecode(prev.end_ms)}）`,
      });
    }
  }
  return issues;
}

/** 序列化为序号连续的标准 SRT */
function serializeSrt(segs) {
  return (
    segs
      .map((s, idx) => {
        return (
          `${idx + 1}\n` +
          `${formatTimecode(s.start_ms)} --> ${formatTimecode(s.end_ms)}\n` +
          `${(s.text || '').replace(/\r/g, '')}`
        );
      })
      .join('\n\n') + '\n'
  );
}

module.exports = {
  parseSrt,
  validateSegments,
  serializeSrt,
  formatTimecode,
  parseTimecodeLine,
};
