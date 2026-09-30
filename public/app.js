'use strict';

/* ================= 基础工具 ================= */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function pad(n, w) {
  return String(n).padStart(w, '0');
}
function msToTc(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const x = ms % 1000;
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(x, 3)}`;
}
function tcToMs(tc) {
  const m = /^\s*(\d{1,2}):([0-5]?\d):([0-5]?\d)[,.](\d{1,3})\s*$/.exec(tc || '');
  if (!m) return NaN;
  const [, h, mm, ss, msStr] = m;
  return (+h) * 3600000 + (+mm) * 60000 + (+ss) * 1000 + +msStr.padEnd(3, '0');
}

let toastTimer = null;
function toast(msg, kind = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast ${kind}`;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3200);
}

async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const resp = await fetch(url, opts);
  let data = null;
  try {
    data = await resp.json();
  } catch {
    /* 非 JSON（导出失败之外的响应都应是 JSON） */
  }
  if (!resp.ok) {
    const err = new Error((data && data.error) || `请求失败 (${resp.status})`);
    err.status = resp.status;
    err.data = data;
    throw err;
  }
  return data;
}

/* ================= 全局状态 ================= */

const state = {
  currentId: null,
  meta: null,
  tab: 'origin',
  branchSegs: { a: [], b: [] },
  editing: { a: null, b: null }, // 当前正在编辑的 ord
  preview: null,
  resolutions: {}, // groupKey -> 'a' | 'b'
};

/* ================= 列表视图 / 导入 ================= */

async function loadList() {
  const { manuscripts } = await api('GET', '/api/manuscripts');
  const tbody = $('#manuscript-table tbody');
  tbody.innerHTML = '';
  $('#empty-tip').classList.toggle('hidden', manuscripts.length > 0);

  manuscripts.forEach((m) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${m.id}</td>
      <td>${esc(m.name)}</td>
      <td>${m.origin_count}</td>
      <td>${m.a_count ? `<span class="badge on-a">${m.a_count}</span>` : '<span class="badge">—</span>'}</td>
      <td>${m.b_count ? `<span class="badge on-b">${m.b_count}</span>` : '<span class="badge">—</span>'}</td>
      <td>${m.merged_count ? `<span class="badge on-m">${m.merged_count}</span>` : '<span class="badge">—</span>'}</td>
      <td>${esc(m.created_at)}</td>
      <td><button class="btn small primary">打开</button></td>`;
    $('button', tr).addEventListener('click', () => openDetail(m.id));
    tbody.appendChild(tr);
  });
}

$('#import-file').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    $('#import-text').value = reader.result;
    if (!$('#import-name').value.trim()) {
      $('#import-name').value = file.name.replace(/\.srt$/i, '');
    }
  };
  reader.readAsText(file, 'utf-8');
});

$('#btn-import').addEventListener('click', async () => {
  const srt = $('#import-text').value;
  const name = $('#import-name').value.trim();
  const errBox = $('#import-errors');
  errBox.classList.add('hidden');
  if (!srt.trim()) {
    showImportErrors(['请先选择文件或粘贴 SRT 内容']);
    return;
  }
  try {
    const r = await api('POST', '/api/manuscripts', { name, srt });
    toast(`导入成功，共 ${r.segment_count} 条片段`, 'ok');
    $('#import-text').value = '';
    $('#import-name').value = '';
    $('#import-file').value = '';
    await loadList();
  } catch (err) {
    if (err.data && err.data.errors) {
      showImportErrors(err.data.errors.map((e) => `第 ${e.line} 行：${e.message}`));
    } else {
      showImportErrors([err.message]);
    }
  }
});

function showImportErrors(lines) {
  const box = $('#import-errors');
  box.innerHTML =
    `<div>❌ 导入被拒绝（未写入任何数据），共 ${lines.length} 处问题：</div>
     <ul>${lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`;
  box.classList.remove('hidden');
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* ================= 详情视图 ================= */

async function openDetail(id) {
  state.currentId = id;
  state.editing = { a: null, b: null };
  state.preview = null;
  state.resolutions = {};
  $('#list-view').classList.add('hidden');
  $('#detail-view').classList.remove('hidden');

  const { manuscript } = await api('GET', `/api/manuscripts/${id}`);
  state.meta = manuscript;
  $('#detail-title').textContent = `${manuscript.name}（#${manuscript.id}）`;

  switchTab(manuscript.has_branch_a ? 'a' : 'origin');
}

$('#btn-back').addEventListener('click', async () => {
  $('#detail-view').classList.add('hidden');
  $('#list-view').classList.remove('hidden');
  await loadList();
});

function switchTab(tab) {
  state.tab = tab;
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
  $$('.tab-panel').forEach((p) =>
    p.classList.toggle('active', p.dataset.panel === tab)
  );
  if (tab === 'origin') loadOrigin();
  if (tab === 'a' || tab === 'b') loadBranch(tab);
  if (tab === 'merged') loadMerged();
  if (tab === 'merge') resetMergePanel();
}
$$('.tab').forEach((t) =>
  t.addEventListener('click', () => switchTab(t.dataset.tab))
);

const mid = () => state.currentId;

/* ---------- 原稿 ---------- */

async function loadOrigin() {
  const { segments } = await api('GET', `/api/manuscripts/${mid()}/origin`);
  $('#origin-segments').innerHTML = segments.map(staticSegHtml).join('');
}

function staticSegHtml(s) {
  return `
    <div class="seg origin-seg">
      <div class="seg-top">
        <span class="seg-num">#${s.ord}</span>
        <span class="seg-time">${msToTc(s.start_ms)} → ${msToTc(s.end_ms)}</span>
      </div>
      <div class="seg-text">${esc(s.text)}</div>
    </div>`;
}

$('#btn-view-origin-raw').addEventListener('click', async () => {
  const { raw_srt } = await api('GET', `/api/manuscripts/${mid()}/origin`);
  openModal('原稿 SRT 全文（只读）', raw_srt);
});

/* ---------- 分支创建 / 恢复 / 加载 ---------- */

$$('.branch-create').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const b = btn.dataset.branch;
    try {
      const r = await api('POST', `/api/manuscripts/${mid()}/branches/${b}`);
      toast(`已从原稿创建分支 ${b.toUpperCase()}（${r.count} 条）`, 'ok');
      await refreshMeta();
      loadBranch(b);
    } catch (err) {
      toast(err.message, 'err');
    }
  });
});

$$('.branch-reset').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const b = btn.dataset.branch;
    if (!confirm(`确定把分支 ${b.toUpperCase()} 全部恢复为原稿？当前修订将被丢弃。`)) return;
    try {
      await api('POST', `/api/manuscripts/${mid()}/branches/${b}/reset`);
      toast(`分支 ${b.toUpperCase()} 已恢复为原稿`, 'ok');
      state.editing[b] = null;
      await loadBranch(b);
    } catch (err) {
      toast(err.message, 'err');
    }
  });
});

$$('.branch-export').forEach((btn) => {
  btn.addEventListener('click', () => doExport(btn.dataset.branch));
});

async function refreshMeta() {
  const { manuscript } = await api('GET', `/api/manuscripts/${mid()}`);
  state.meta = manuscript;
  updateBranchChrome('a');
  updateBranchChrome('b');
}

function updateBranchChrome(b) {
  const panel = $(`.tab-panel[data-panel="${b}"]`);
  const exists = b === 'a' ? state.meta.has_branch_a : state.meta.has_branch_b;
  $('.branch-create', panel).classList.toggle('hidden', exists);
  $('.branch-reset', panel).classList.toggle('hidden', !exists);
  $('.branch-export', panel).classList.toggle('hidden', !exists);
  const st = $('.branch-status', panel);
  st.classList.toggle('hidden', !exists);
  if (exists) st.textContent = `共 ${state.branchSegs[b]?.length || 0} 条，可直接在下方修改、拆分或合并`;
}

async function loadBranch(b) {
  const panel = $(`.tab-panel[data-panel="${b}"]`);
  const list = $(`.branch-segments[data-branch="${b}"]`);
  try {
    const { segments } = await api(
      'GET',
      `/api/manuscripts/${mid()}/branches/${b}/segments`
    );
    state.branchSegs[b] = segments;
    state.editing[b] = null;
    updateBranchChrome(b);
    renderBranch(b, list);
  } catch (err) {
    state.branchSegs[b] = [];
    updateBranchChrome(b);
    list.innerHTML = `<p class="hint">${esc(err.message)}。点击上方按钮创建。</p>`;
  }
}

function renderBranch(b, list) {
  const segs = state.branchSegs[b];
  list.innerHTML = '';
  segs.forEach((s, idx) => {
    const div = document.createElement('div');
    if (state.editing[b] === s.ord) {
      div.innerHTML = editSegHtml(b, s, idx);
      bindEditSeg(div, b, s);
    } else {
      div.innerHTML = viewSegHtml(b, s, idx, segs.length);
      bindViewSeg(div, b, s);
    }
    list.appendChild(div);
  });
}

function originTag(s) {
  let ids = [];
  try { ids = JSON.parse(s.origin_ids || '[]'); } catch { ids = []; }
  return ids.length ? `<span class="seg-origin-tag">来源原稿 #${esc(ids.join(', #'))}</span>` : '';
}

function viewSegHtml(b, s, idx, total) {
  return `
    <div class="seg">
      <div class="seg-top">
        <span class="seg-num">#${s.ord}</span>
        <span class="seg-time">${msToTc(s.start_ms)} → ${msToTc(s.end_ms)}</span>
        ${originTag(s)}
        <span class="seg-actions">
          <button class="btn small act-edit">✏️ 修正</button>
          <button class="btn small act-split">✂️ 拆分</button>
          <button class="btn small act-merge" ${idx >= total - 1 ? 'disabled' : ''}>⑃ 与下一条合并</button>
        </span>
      </div>
      <div class="seg-text">${esc(s.text)}</div>
    </div>`;
}

function editSegHtml(b, s) {
  return `
    <div class="seg editing">
      <div class="seg-top">
        <span class="seg-num">#${s.ord} 编辑中</span>
        ${originTag(s)}
      </div>
      <div class="seg-edit-grid">
        <label>起点
          <input class="in-start" value="${msToTc(s.start_ms)}" />
        </label>
        <label>终点
          <input class="in-end" value="${msToTc(s.end_ms)}" />
        </label>
        <label class="full">文案
          <textarea class="in-text">${esc(s.text)}</textarea>
        </label>
      </div>
      <div class="seg-actions" style="margin-left:0">
        <button class="btn small primary act-save">保存</button>
        <button class="btn small act-cancel">取消</button>
      </div>
    </div>`;
}

function bindViewSeg(root, b, s) {
  $('.act-edit', root).addEventListener('click', () => {
    state.editing[b] = s.ord;
    renderBranch(b, $(`.branch-segments[data-branch="${b}"]`));
  });
  $('.act-split', root).addEventListener('click', async () => {
    if (!confirm(`将 #${s.ord} 按时间中点拆成两条？拆分后可分别修正文案与时间。`)) return;
    try {
      const r = await api(
        'POST',
        `/api/manuscripts/${mid()}/branches/${b}/segments/${s.ord}/split`,
        {}
      );
      state.branchSegs[b] = r.segments;
      renderBranch(b, $(`.branch-segments[data-branch="${b}"]`));
      updateBranchChrome(b);
      toast('已拆分', 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
  });
  $('.act-merge', root).addEventListener('click', async () => {
    if (!confirm(`把 #${s.ord} 与下一条合并为一条？`)) return;
    try {
      const r = await api(
        'POST',
        `/api/manuscripts/${mid()}/branches/${b}/segments/${s.ord}/merge`,
        {}
      );
      state.branchSegs[b] = r.segments;
      renderBranch(b, $(`.branch-segments[data-branch="${b}"]`));
      updateBranchChrome(b);
      toast('已合并', 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
  });
}

function bindEditSeg(root, b, s) {
  $('.act-cancel', root).addEventListener('click', () => {
    state.editing[b] = null;
    renderBranch(b, $(`.branch-segments[data-branch="${b}"]`));
  });
  $('.act-save', root).addEventListener('click', async () => {
    const start = tcToMs($('.in-start', root).value);
    const end = tcToMs($('.in-end', root).value);
    const text = $('.in-text', root).value;
    if (Number.isNaN(start) || Number.isNaN(end)) {
      toast('时间码格式应为 00:00:01,000', 'err');
      return;
    }
    try {
      await api(
        'PUT',
        `/api/manuscripts/${mid()}/branches/${b}/segments/${s.ord}`,
        { start_ms: start, end_ms: end, text }
      );
      state.editing[b] = null;
      const { segments } = await api(
        'GET',
        `/api/manuscripts/${mid()}/branches/${b}/segments`
      );
      state.branchSegs[b] = segments;
      renderBranch(b, $(`.branch-segments[data-branch="${b}"]`));
      toast('已保存修正', 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
  });
}

/* ---------- 导出 ---------- */

async function doExport(branch) {
  const url = `/api/manuscripts/${mid()}/export/${branch}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    let data = null;
    try { data = await resp.json(); } catch { /* ignore */ }
    if (data && data.issues) {
      const msg =
        `❌ 导出校验未通过，未生成文件，共 ${data.issues.length} 处：\n\n` +
        data.issues.map((i) => `· 第 ${i.ord} 条（${i.start} → ${i.end}）：${i.message}`).join('\n');
      openModal('导出失败：问题片段', msg);
    } else {
      toast((data && data.error) || '导出失败', 'err');
    }
    return;
  }
  const blob = await resp.blob();
  const filename = filenameFromDisposition(resp.headers.get('Content-Disposition')) ||
    `manuscript_${mid()}_${branch}.srt`;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
  toast('已导出序号连续的 SRT', 'ok');
}

function filenameFromDisposition(cd) {
  if (!cd) return null;
  const m = /filename="?([^";]+)"?/.exec(cd);
  return m ? m[1] : null;
}

$('#btn-merged-export').addEventListener('click', () => doExport('merged'));

/* ---------- 合并结果页 ---------- */

async function loadMerged() {
  const box = $('#merged-segments');
  try {
    const { segments } = await api(
      'GET',
      `/api/manuscripts/${mid()}/branches/merged/segments`
    );
    box.innerHTML = segments.map(staticSegHtml).join('');
  } catch (err) {
    box.innerHTML = `<p class="hint">${esc(err.message)}。请到“合并 A+B”页生成。</p>`;
  }
}

/* ================= 合并面板 ================= */

function resetMergePanel() {
  state.preview = null;
  state.resolutions = {};
  $('#merge-summary').classList.add('hidden');
  $('#merge-conflicts').innerHTML = '';
  $('#merge-auto').innerHTML = '';
  $('#merge-commit-bar').hidden = true;
  $('#merge-commit-msg').textContent = '';
}

$('#btn-merge-preview').addEventListener('click', loadPreview);

async function loadPreview() {
  resetMergePanel();
  try {
    const data = await api('GET', `/api/manuscripts/${mid()}/merge-preview`);
    state.preview = data;
    renderPreview();
  } catch (err) {
    toast(err.message, 'err');
  }
}

function miniSegHtml(seg) {
  return `
    <div class="mini-seg">
      <span class="seg-time">${msToTc(seg.start_ms)} → ${msToTc(seg.end_ms)}</span>
      <div class="seg-text">${esc(seg.text)}</div>
    </div>`;
}

function originRefHtml(group) {
  return `
    <div class="choice origin-ref">
      <div class="choice-head">📄 原稿内容</div>
      ${group.origin.map((o) => miniSegHtml(o)).join('')}
    </div>`;
}

function renderPreview() {
  const p = state.preview;
  const sum = $('#merge-summary');
  sum.classList.remove('hidden');
  if (p.conflict_count === 0) {
    sum.textContent = `✅ 没有冲突：${p.auto_count} 组改动将自动合并（含仅单边修改与原稿保留项）。`;
  } else {
    sum.innerHTML =
      `⚠️ 检测到 <strong>${p.conflict_count}</strong> 组来源片段被两边同时修改，请逐组选择保留哪一边；` +
      `另有 ${p.auto_count} 组无冲突将自动保留。`;
  }

  // 冲突组
  const cBox = $('#merge-conflicts');
  cBox.innerHTML = '';
  p.conflicts.forEach((g) => {
    const wrap = document.createElement('div');
    wrap.className = 'merge-group conflict';
    wrap.innerHTML = `
      <div class="mg-head">
        冲突：来源原稿 #${esc(g.origin_ids.join(', #'))}
        <span class="mg-tag need">两边都改过，必须选择</span>
      </div>
      <div class="mg-body">
        ${originRefHtml(g)}
        <div class="choice a" data-choice="a">
          <div class="choice-head">🅰️ 分支 A 的内容（${g.a.length} 条）</div>
          ${g.a.map(miniSegHtml).join('')}
        </div>
        <div class="choice b" data-choice="b">
          <div class="choice-head">🅱️ 分支 B 的内容（${g.b.length} 条）</div>
          ${g.b.map(miniSegHtml).join('')}
        </div>
      </div>`;
    $$('.choice.a, .choice.b', wrap).forEach((choice) => {
      choice.addEventListener('click', () => {
        state.resolutions[g.key] = choice.dataset.choice;
        $('.choice.a', wrap).classList.toggle('selected', choice.dataset.choice === 'a');
        $('.choice.b', wrap).classList.toggle('selected', choice.dataset.choice === 'b');
        updateCommitState();
      });
    });
    cBox.appendChild(wrap);
  });

  // 自动组（默认折叠）
  const aBox = $('#merge-auto');
  aBox.innerHTML = '';
  if (p.auto.length) {
    const details = document.createElement('details');
    details.innerHTML = `<summary class="autos-toggle">查看 ${p.auto.length} 组无冲突改动明细</summary>`;
    const inner = document.createElement('div');
    inner.style.marginTop = '8px';
    inner.innerHTML = p.auto
      .map((g) => {
        const tag =
          g.source === 'a'
            ? '<span class="mg-tag auto-a">采用 A 的改动</span>'
            : g.source === 'b'
              ? '<span class="mg-tag auto-b">采用 B 的改动</span>'
              : '<span class="mg-tag origin">原稿保留</span>';
        return `
          <div class="merge-group auto">
            <div class="mg-head">来源原稿 #${esc(g.origin_ids.join(', #'))} ${tag}</div>
            <div class="mg-body">${g.segments.map(miniSegHtml).join('')}</div>
          </div>`;
      })
      .join('');
    details.appendChild(inner);
    aBox.appendChild(details);
  }

  updateCommitState();
  $('#merge-commit-bar').hidden = false;
}

function updateCommitState() {
  const p = state.preview;
  if (!p) return;
  const chosen = Object.keys(state.resolutions).length;
  const msg = $('#merge-commit-msg');
  if (p.conflict_count === 0) {
    msg.textContent = '可直接提交。';
  } else {
    msg.textContent = `已选择 ${chosen} / ${p.conflict_count} 组冲突`;
  }
  $('#btn-merge-commit').disabled = chosen < p.conflict_count;
}

$('#btn-merge-commit').addEventListener('click', async () => {
  const p = state.preview;
  if (Object.keys(state.resolutions).length < p.conflict_count) {
    toast('还有冲突未选择', 'err');
    return;
  }
  try {
    const r = await api('POST', `/api/manuscripts/${mid()}/merge`, {
      resolutions: state.resolutions,
    });
    toast(`合并完成，合并稿共 ${r.merged_count} 条`, 'ok');
    await refreshMeta();
    switchTab('merged');
  } catch (err) {
    toast(err.message, 'err');
  }
});

/* ================= 模态 ================= */

function openModal(title, body) {
  $('#modal-title').textContent = title;
  $('#modal-body').textContent = body;
  $('#modal-mask').classList.remove('hidden');
}
$('#modal-close').addEventListener('click', () => $('#modal-mask').classList.add('hidden'));
$('#modal-mask').addEventListener('click', (e) => {
  if (e.target === $('#modal-mask')) $('#modal-mask').classList.add('hidden');
});

/* ================= 启动 ================= */

loadList().catch((err) => toast(err.message, 'err'));
