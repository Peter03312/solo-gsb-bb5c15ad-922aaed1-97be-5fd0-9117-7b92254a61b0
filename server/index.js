'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const { getDb } = require('./db');
const {
  parseSrt,
  validateSegments,
  serializeSrt,
  formatTimecode,
} = require('./srt');
const { computePreview, buildMergedSegments } = require('./merge');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const db = getDb();

const BRANCHES = ['a', 'b'];
const ALL_BRANCHES = ['origin', 'a', 'b', 'merged'];

// ---------- 小工具 ----------

function badRequest(res, message, extra = {}) {
  return res.status(400).json({ error: message, ...extra });
}

function notFound(res, message) {
  return res.status(404).json({ error: message });
}

function getManuscriptOr404(res, id) {
  const m = db
    .prepare('SELECT id, name, raw_srt, created_at FROM manuscripts WHERE id = ?')
    .get(id);
  if (!m) {
    notFound(res, '稿件不存在');
    return null;
  }
  return m;
}

function getRows(manuscriptId, branch) {
  return db
    .prepare(
      `SELECT id, ord, start_ms, end_ms, text, origin_ids
       FROM segments
       WHERE manuscript_id = ? AND branch = ?
       ORDER BY ord ASC`
    )
    .all(manuscriptId, branch);
}

function countRows(manuscriptId, branch) {
  return db
    .prepare(
      'SELECT COUNT(*) AS n FROM segments WHERE manuscript_id = ? AND branch = ?'
    )
    .get(manuscriptId, branch).n;
}

function reorder(txDb, manuscriptId, branch) {
  const rows = txDb
    .prepare(
      'SELECT id FROM segments WHERE manuscript_id = ? AND branch = ? ORDER BY ord ASC, id ASC'
    )
    .all(manuscriptId, branch);
  const upd = txDb.prepare(
    'UPDATE segments SET ord = ? WHERE id = ? AND manuscript_id = ? AND branch = ?'
  );
  rows.forEach((r, idx) => upd.run(idx + 1, r.id, manuscriptId, branch));
}

function replaceBranchRows(manuscriptId, branch, segments) {
  const tx = db.transaction((segs) => {
    db.prepare(
      'DELETE FROM segments WHERE manuscript_id = ? AND branch = ?'
    ).run(manuscriptId, branch);
    const ins = db.prepare(
      `INSERT INTO segments (manuscript_id, branch, ord, start_ms, end_ms, text, origin_ids)
       VALUES (@manuscript_id, @branch, @ord, @start_ms, @end_ms, @text, @origin_ids)`
    );
    segs.forEach((s, idx) => {
      ins.run({
        manuscript_id: manuscriptId,
        branch,
        ord: idx + 1,
        start_ms: Math.round(s.start_ms),
        end_ms: Math.round(s.end_ms),
        text: s.text,
        origin_ids: JSON.stringify(s.origin_ids || []),
      });
    });
  });
  tx(segments);
}

// ---------- 稿件 ----------

// 稿件列表
app.get('/api/manuscripts', (req, res) => {
  const list = db
    .prepare(
      `SELECT m.id, m.name, m.created_at,
              (SELECT COUNT(*) FROM segments s WHERE s.manuscript_id = m.id AND s.branch = 'origin') AS origin_count,
              (SELECT COUNT(*) FROM segments s WHERE s.manuscript_id = m.id AND s.branch = 'a') AS a_count,
              (SELECT COUNT(*) FROM segments s WHERE s.manuscript_id = m.id AND s.branch = 'b') AS b_count,
              (SELECT COUNT(*) FROM segments s WHERE s.manuscript_id = m.id AND s.branch = 'merged') AS merged_count
       FROM manuscripts m
       ORDER BY m.id DESC`
    )
    .all();
  res.json({ manuscripts: list });
});

// 导入 SRT：解析失败（含格式/时间码错误、序号不连续、重叠等）整份拒绝
app.post('/api/manuscripts', (req, res) => {
  const { name, srt } = req.body || {};
  if (!srt || typeof srt !== 'string' || srt.trim() === '') {
    return badRequest(res, '缺少 SRT 内容');
  }
  const { segments, errors } = parseSrt(srt);
  if (errors.length > 0) {
    return badRequest(res, 'SRT 解析失败，整份稿件未导入', { errors });
  }

  const finalName =
    name && String(name).trim()
      ? String(name).trim()
      : `导入稿件 ${new Date().toLocaleString('zh-CN')}`;

  const tx = db.transaction(() => {
    const info = db
      .prepare('INSERT INTO manuscripts (name, raw_srt) VALUES (?, ?)')
      .run(finalName, srt.replace(/\r\n?/g, '\n'));
    const manuscriptId = info.lastInsertRowid;
    const ins = db.prepare(
      `INSERT INTO segments (manuscript_id, branch, ord, start_ms, end_ms, text, origin_ids)
       VALUES (?, 'origin', ?, ?, ?, ?, ?)`
    );
    segments.forEach((s) => {
      ins.run(
        manuscriptId,
        s.ord,
        s.start_ms,
        s.end_ms,
        s.text,
        JSON.stringify([])
      );
    });
    return manuscriptId;
  });

  const id = tx();
  res.status(201).json({ id, name: finalName, segment_count: segments.length });
});

// 稿件详情（含原稿全文）
app.get('/api/manuscripts/:id', (req, res) => {
  const id = Number(req.params.id);
  const m = getManuscriptOr404(res, id);
  if (!m) return;
  res.json({
    manuscript: {
      id: m.id,
      name: m.name,
      created_at: m.created_at,
      has_branch_a: countRows(id, 'a') > 0,
      has_branch_b: countRows(id, 'b') > 0,
      has_merged: countRows(id, 'merged') > 0,
    },
  });
});

// 查看原稿（原始 SRT 全文）
app.get('/api/manuscripts/:id/origin', (req, res) => {
  const id = Number(req.params.id);
  const m = getManuscriptOr404(res, id);
  if (!m) return;
  res.json({ name: m.name, raw_srt: m.raw_srt, segments: getRows(id, 'origin') });
});

// 从原稿创建修订分支（同一原稿两条：a、b，各自独立）
app.post('/api/manuscripts/:id/branches/:branch', (req, res) => {
  const id = Number(req.params.id);
  const branch = String(req.params.branch);
  if (!BRANCHES.includes(branch)) return badRequest(res, '分支只能是 a 或 b');
  const m = getManuscriptOr404(res, id);
  if (!m) return;

  if (countRows(id, branch) > 0) {
    return badRequest(res, `分支 ${branch.toUpperCase()} 已存在`);
  }
  const exists = db
    .prepare(
      'SELECT 1 FROM branches WHERE manuscript_id = ? AND branch = ?'
    )
    .get(id, branch);

  const origin = getRows(id, 'origin');
  const tx = db.transaction(() => {
    if (!exists) {
      db.prepare(
        'INSERT INTO branches (manuscript_id, branch) VALUES (?, ?)'
      ).run(id, branch);
    }
    const ins = db.prepare(
      `INSERT INTO segments (manuscript_id, branch, ord, start_ms, end_ms, text, origin_ids)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    origin.forEach((o, idx) => {
      ins.run(id, branch, idx + 1, o.start_ms, o.end_ms, o.text, JSON.stringify([o.id]));
    });
  });
  tx();
  res.status(201).json({ branch, count: origin.length });
});

// 恢复：把分支重置回原稿
app.post('/api/manuscripts/:id/branches/:branch/reset', (req, res) => {
  const id = Number(req.params.id);
  const branch = String(req.params.branch);
  if (!BRANCHES.includes(branch)) return badRequest(res, '分支只能是 a 或 b');
  const m = getManuscriptOr404(res, id);
  if (!m) return;
  if (countRows(id, branch) === 0) {
    return badRequest(res, `分支 ${branch.toUpperCase()} 尚未创建`);
  }
  const origin = getRows(id, 'origin');
  const segs = origin.map((o) => ({
    start_ms: o.start_ms,
    end_ms: o.end_ms,
    text: o.text,
    origin_ids: [o.id],
  }));
  replaceBranchRows(id, branch, segs);
  res.json({ branch, count: segs.length, message: '已恢复为原稿内容' });
});

// 获取分支片段
app.get('/api/manuscripts/:id/branches/:branch/segments', (req, res) => {
  const id = Number(req.params.id);
  const branch = String(req.params.branch);
  if (!ALL_BRANCHES.includes(branch)) return badRequest(res, '未知分支');
  const m = getManuscriptOr404(res, id);
  if (!m) return;
  const rows = getRows(id, branch);
  if (rows.length === 0 && branch !== 'origin') {
    return badRequest(res, `分支 ${branch.toUpperCase()} 尚未创建`);
  }
  res.json({ branch, segments: rows });
});

// 修改单条片段（文案 / 起 / 止；不改变来源）
app.put('/api/manuscripts/:id/branches/:branch/segments/:ord', (req, res) => {
  const id = Number(req.params.id);
  const branch = String(req.params.branch);
  const ord = Number(req.params.ord);
  if (!BRANCHES.includes(branch)) return badRequest(res, '修订分支才能编辑');
  const m = getManuscriptOr404(res, id);
  if (!m) return;

  const row = db
    .prepare(
      'SELECT * FROM segments WHERE manuscript_id = ? AND branch = ? AND ord = ?'
    )
    .get(id, branch, ord);
  if (!row) return notFound(res, '片段不存在');

  const { start_ms, end_ms, text } = req.body || {};
  const ns = Number.isFinite(Number(start_ms)) ? Number(start_ms) : row.start_ms;
  const ne = Number.isFinite(Number(end_ms)) ? Number(end_ms) : row.end_ms;
  const nt = typeof text === 'string' ? text : row.text;

  if (!Number.isFinite(ns) || ns < 0) return badRequest(res, '起点必须为非负毫秒数');
  if (!Number.isFinite(ne) || ne < 0) return badRequest(res, '终点必须为非负毫秒数');
  if (ns >= ne) return badRequest(res, '起点必须早于终点');
  if (nt.trim() === '') return badRequest(res, '文案不能为空');

  db.prepare(
    'UPDATE segments SET start_ms = ?, end_ms = ?, text = ? WHERE id = ?'
  ).run(Math.round(ns), Math.round(ne), nt, row.id);
  const updated = db
    .prepare(
      'SELECT id, ord, start_ms, end_ms, text, origin_ids FROM segments WHERE id = ?'
    )
    .get(row.id);
  res.json(updated);
});

// 拆分片段：在该片段位置拆成两段（默认时间平分、后半文案相同，随后可再逐条编辑）
app.post(
  '/api/manuscripts/:id/branches/:branch/segments/:ord/split',
  (req, res) => {
    const id = Number(req.params.id);
    const branch = String(req.params.branch);
    const ord = Number(req.params.ord);
    if (!BRANCHES.includes(branch)) return badRequest(res, '修订分支才能拆分');
    const m = getManuscriptOr404(res, id);
    if (!m) return;

    const row = db
      .prepare(
        'SELECT * FROM segments WHERE manuscript_id = ? AND branch = ? AND ord = ?'
      )
      .get(id, branch, ord);
    if (!row) return notFound(res, '片段不存在');

    let originIds;
    try {
      originIds = JSON.parse(row.origin_ids || '[]');
    } catch {
      originIds = [];
    }

    const body = req.body || {};
    const cut =
      Number.isFinite(Number(body.cut_ms)) &&
      Number(body.cut_ms) > row.start_ms &&
      Number(body.cut_ms) < row.end_ms
        ? Math.round(Number(body.cut_ms))
        : Math.round((row.start_ms + row.end_ms) / 2);
    const firstText =
      typeof body.first_text === 'string' && body.first_text.trim()
        ? body.first_text
        : row.text;
    const secondText =
      typeof body.second_text === 'string' && body.second_text.trim()
        ? body.second_text
        : row.text;

    const tx = db.transaction(() => {
      // 两阶段移位，规避逐行 +1 时唯一约束立即冲突：
      // 先把后续行挪到大负号区间，再整体 +1 回到正数目标区间
      db.prepare(
        'UPDATE segments SET ord = -ord - 1000000 WHERE manuscript_id = ? AND branch = ? AND ord > ?'
      ).run(id, branch, ord);
      db.prepare(
        'UPDATE segments SET ord = -ord - 1000000 + 1 WHERE manuscript_id = ? AND branch = ? AND ord < -1000000'
      ).run(id, branch);
      // 删除原行，腾出 ord 与 ord+1
      db.prepare('DELETE FROM segments WHERE id = ?').run(row.id);
      const ins = db.prepare(
        `INSERT INTO segments (manuscript_id, branch, ord, start_ms, end_ms, text, origin_ids)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      );
      ins.run(id, branch, ord, row.start_ms, cut, firstText, row.origin_ids);
      ins.run(
        id,
        branch,
        ord + 1,
        cut,
        row.end_ms,
        secondText,
        JSON.stringify(originIds)
      );
    });
    tx();
    res.status(201).json({ segments: getRows(id, branch) });
  }
);

// 合并片段：把 ord 与 ord+1 合成一段，来源集合取并集
app.post(
  '/api/manuscripts/:id/branches/:branch/segments/:ord/merge',
  (req, res) => {
    const id = Number(req.params.id);
    const branch = String(req.params.branch);
    const ord = Number(req.params.ord);
    if (!BRANCHES.includes(branch)) return badRequest(res, '修订分支才能合并');
    const m = getManuscriptOr404(res, id);
    if (!m) return;

    const first = db
      .prepare(
        'SELECT * FROM segments WHERE manuscript_id = ? AND branch = ? AND ord = ?'
      )
      .get(id, branch, ord);
    const second = db
      .prepare(
        'SELECT * FROM segments WHERE manuscript_id = ? AND branch = ? AND ord = ?'
      )
      .get(id, branch, ord + 1);
    if (!first || !second) return badRequest(res, '只有相邻的两条片段可以合并');

    let ids1 = [];
    let ids2 = [];
    try {
      ids1 = JSON.parse(first.origin_ids || '[]');
    } catch {
      ids1 = [];
    }
    try {
      ids2 = JSON.parse(second.origin_ids || '[]');
    } catch {
      ids2 = [];
    }
    const union = [...new Set([...ids1, ...ids2].map(Number))].sort(
      (x, y) => x - y
    );

    const body = req.body || {};
    const text =
      typeof body.text === 'string' && body.text.trim()
        ? body.text
        : `${first.text}\n${second.text}`;

    const tx = db.transaction(() => {
      db.prepare(
        `UPDATE segments SET start_ms = ?, end_ms = ?, text = ?, origin_ids = ? WHERE id = ?`
      ).run(
        first.start_ms,
        second.end_ms,
        text,
        JSON.stringify(union),
        first.id
      );
      db.prepare('DELETE FROM segments WHERE id = ?').run(second.id);
      reorder(db, id, branch);
    });
    tx();
    res.json({ segments: getRows(id, branch) });
  }
);

// ---------- 三向合并 ----------

app.get('/api/manuscripts/:id/merge-preview', (req, res) => {
  const id = Number(req.params.id);
  const m = getManuscriptOr404(res, id);
  if (!m) return;
  if (countRows(id, 'a') === 0 || countRows(id, 'b') === 0) {
    return badRequest(res, '需要先从原稿创建 A、B 两条修订分支');
  }
  const origin = getRows(id, 'origin');
  const aRows = getRows(id, 'a');
  const bRows = getRows(id, 'b');
  const preview = computePreview(origin, aRows, bRows);
  res.json({
    auto: preview.auto,
    conflicts: preview.conflicts,
    auto_count: preview.auto.length,
    conflict_count: preview.conflicts.length,
  });
});

// 提交合并结果：冲突必须逐个选择 a 或 b；结果写入 merged 分支
app.post('/api/manuscripts/:id/merge', (req, res) => {
  const id = Number(req.params.id);
  const m = getManuscriptOr404(res, id);
  if (!m) return;
  if (countRows(id, 'a') === 0 || countRows(id, 'b') === 0) {
    return badRequest(res, '需要先从原稿创建 A、B 两条修订分支');
  }
  const resolutions = (req.body && req.body.resolutions) || {};
  if (typeof resolutions !== 'object') {
    return badRequest(res, '冲突选择格式不正确');
  }

  const origin = getRows(id, 'origin');
  const aRows = getRows(id, 'a');
  const bRows = getRows(id, 'b');

  let merged;
  try {
    merged = buildMergedSegments(origin, aRows, bRows, resolutions);
  } catch (err) {
    if (err.code === 'MERGE_UNRESOLVED') return badRequest(res, err.message);
    throw err;
  }

  const tx = db.transaction(() => {
    replaceBranchRows(id, 'merged', merged);
    db.prepare('INSERT INTO merges (manuscript_id, resolved) VALUES (?, ?)').run(
      id,
      JSON.stringify(resolutions)
    );
  });
  tx();
  res.status(201).json({ merged_count: merged.length });
});

// ---------- 导出 ----------

app.get('/api/manuscripts/:id/export/:branch', (req, res) => {
  const id = Number(req.params.id);
  const branch = String(req.params.branch);
  if (!ALL_BRANCHES.includes(branch)) return badRequest(res, '未知分支');
  const m = getManuscriptOr404(res, id);
  if (!m) return;
  const rows = getRows(id, branch);
  if (rows.length === 0) return badRequest(res, '该分支没有可导出的片段');

  // 导出前检查：非负、起点早于终点、片段不重叠、文本非空
  const issues = validateSegments(rows);
  if (issues.length > 0) {
    return res.status(409).json({
      error: '导出校验未通过，未生成文件',
      issues: issues.map((it) => ({
        ord: it.ord,
        start: formatTimecode(rows[it.ord - 1] ? rows[it.ord - 1].start_ms : 0),
        end: formatTimecode(rows[it.ord - 1] ? rows[it.ord - 1].end_ms : 0),
        message: it.message,
      })),
    });
  }

  const srt = serializeSrt(rows);
  // HTTP 头只允许 Latin-1：ASCII 回退名 + RFC 5987 的 UTF-8 编码名
  const asciiName = `manuscript_${id}_${branch}.srt`;
  const utf8Name = encodeURIComponent(`${m.name || 'manuscript'}_${branch}.srt`);
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${asciiName}"; filename*=UTF-8''${utf8Name}`
  );
  res.send(srt);
});

// 兜底错误处理
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: '服务器内部错误' });
});

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

if (require.main === module) {
  app.listen(PORT, HOST, () => {
    console.log(`排练字幕修订应用已启动: http://localhost:${PORT}`);
  });
}

module.exports = app;
