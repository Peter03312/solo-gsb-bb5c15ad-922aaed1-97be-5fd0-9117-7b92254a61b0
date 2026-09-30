'use strict';

/**
 * 三向合并：以 origin（原稿）为共同基线，识别 A/B 两条分支对同一来源片段的改动。
 *
 * 每个分支片段携带 origin_ids（来源原稿片段 id 集合）：
 *   - 编辑不改变来源集合；
 *   - 拆分会让多行共享同一来源 id；
 *   - 合并会让一行携带多个来源 id（并集）。
 *
 * 由于两边的拓扑可能不同（例如 A 合并了 #1+#2 而 B 只改了 #2），
 * 直接按来源集合精确匹配会漏报冲突。这里先把两边所有片段的来源并集边
 * 做并查集（union-find），得到跨两侧对齐的「来源分量」：
 *   - 分量内两边都有改动           -> 冲突，展示两边各自片段，由用户选择
 *   - 仅一边改动（含拆分/合并结构变化）-> 自动采用改动方
 *   - 两边都未改                   -> 按原稿逐条保留
 * 冲突选择以分量为单位，绝不按保存先后覆盖。
 */

function originIdsOf(row) {
  let ids;
  try {
    ids = JSON.parse(row.origin_ids || '[]');
  } catch {
    ids = [];
  }
  return [...new Set(ids.map(Number))];
}

function componentKey(ids) {
  return [...ids].sort((x, y) => x - y).join('|');
}

class UnionFind {
  constructor(nodes) {
    this.parent = new Map(nodes.map((n) => [n, n]));
  }
  find(x) {
    let root = x;
    while (this.parent.get(root) !== root) root = this.parent.get(root);
    let cur = x;
    while (this.parent.get(cur) !== root) {
      const next = this.parent.get(cur);
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }
  union(a, b) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(rb, ra);
  }
}

/** 判断一条单来源片段是否与对应原稿完全相同 */
function rowEqualsOrigin(row, o) {
  return (
    row.ids.length === 1 &&
    row.start_ms === o.start_ms &&
    row.end_ms === o.end_ms &&
    row.text === o.text
  );
}

function toSideRows(rows) {
  return rows.map((r) => ({
    start_ms: r.start_ms,
    end_ms: r.end_ms,
    text: r.text,
    ids: originIdsOf(r),
  }));
}

function outSegs(sideRows) {
  return sideRows.map((r) => ({
    start_ms: r.start_ms,
    end_ms: r.end_ms,
    text: r.text,
    origin_ids: r.ids,
  }));
}

/**
 * 计算合并预览。
 * @param originRows 原稿片段（含 id / ord / start_ms / end_ms / text，按 ord 排序）
 * @param aRows bRows 分支片段（按 ord 排序，含 origin_ids）
 */
function computePreview(originRows, aRows, bRows) {
  const originById = new Map(originRows.map((r) => [r.id, r]));
  const sideA = toSideRows(aRows);
  const sideB = toSideRows(bRows);

  // 1) 并查集：以所有原稿 id 为节点，任意一侧把多个来源合在一条里就并边
  const uf = new UnionFind(originRows.map((o) => o.id));
  [...sideA, ...sideB].forEach((r) => {
    for (let i = 1; i < r.ids.length; i++) uf.union(r.ids[0], r.ids[i]);
  });

  // 2) 求每个分量的成员（按原稿 ord 排序）
  const compMembers = new Map(); // root -> origin ids in ord 顺序
  originRows.forEach((o) => {
    const root = uf.find(o.id);
    if (!compMembers.has(root)) compMembers.set(root, []);
    compMembers.get(root).push(o.id);
  });
  const components = [...compMembers.entries()]
    .map(([root, ids]) => {
      ids.sort(
        (x, y) => originById.get(x).ord - originById.get(y).ord
      );
      return { root, ids, minOrd: originById.get(ids[0]).ord };
    })
    .sort((x, y) => x.minOrd - y.minOrd);

  // 3) 两侧片段按分量归集
  function rowsByComponent(sideRows) {
    const map = new Map(); // root -> rows
    sideRows.forEach((r) => {
      // 一条片段的所有 id 必属同一分量（并查集保证）
      const root = uf.find(r.ids[0]);
      if (!map.has(root)) map.set(root, []);
      map.get(root).push(r);
    });
    return map;
  }
  const aByComp = rowsByComponent(sideA);
  const bByComp = rowsByComponent(sideB);

  // 4) 逐分量判定改动集合
  // 单来源且与原稿逐条完全相同才算未改；拆分/合并等结构变化一律视为改动
  function changedOrigins(rowsInComp) {
    const changed = new Set();
    rowsInComp.forEach((r) => {
      if (r.ids.length === 1) {
        const o = originById.get(r.ids[0]);
        if (!o || !rowEqualsOrigin(r, o)) changed.add(r.ids[0]);
      } else {
        r.ids.forEach((id) => changed.add(id));
      }
    });
    return changed;
  }

  const auto = [];
  const conflicts = [];
  const componentKeys = [];

  components.forEach((comp) => {
    const rowsA = aByComp.get(comp.root) || [];
    const rowsB = bByComp.get(comp.root) || [];
    const chA = changedOrigins(rowsA);
    const chB = changedOrigins(rowsB);
    const aChanged = chA.size > 0;
    const bChanged = chB.size > 0;
    const key = componentKey(comp.ids);
    componentKeys.push(key);

    const base = {
      key,
      origin_ids: comp.ids,
      origin: comp.ids.map((id) => {
        const o = originById.get(id);
        return {
          id: o.id,
          ord: o.ord,
          start_ms: o.start_ms,
          end_ms: o.end_ms,
          text: o.text,
        };
      }),
    };

    if (aChanged && bChanged) {
      conflicts.push({
        ...base,
        a: outSegs(rowsA),
        b: outSegs(rowsB),
      });
    } else if (aChanged) {
      auto.push({ ...base, source: 'a', segments: outSegs(rowsA) });
    } else if (bChanged) {
      auto.push({ ...base, source: 'b', segments: outSegs(rowsB) });
    } else {
      auto.push({
        ...base,
        source: 'origin',
        segments: comp.ids.map((id) => {
          const o = originById.get(id);
          return {
            start_ms: o.start_ms,
            end_ms: o.end_ms,
            text: o.text,
            origin_ids: [o.id],
          };
        }),
      });
    }
  });

  return { auto, conflicts, componentKeys };
}

/**
 * 依据冲突选择生成合并分支的完整片段序列。
 * @param resolutions {{[componentKey]: 'a'|'b'}} 必须覆盖每个冲突分量
 */
function buildMergedSegments(originRows, aRows, bRows, resolutions) {
  const { auto, conflicts, componentKeys } = computePreview(
    originRows,
    aRows,
    bRows
  );

  const chosenByKey = new Map();
  auto.forEach((g) => chosenByKey.set(g.key, g.segments));

  for (const c of conflicts) {
    const choice = resolutions ? resolutions[c.key] : undefined;
    if (choice !== 'a' && choice !== 'b') {
      const err = new Error(
        `来源片段 ${c.key.replace(/\|/g, ',')} 的冲突尚未作出选择`
      );
      err.code = 'MERGE_UNRESOLVED';
      throw err;
    }
    chosenByKey.set(c.key, choice === 'a' ? c.a : c.b);
  }

  const out = [];
  componentKeys.forEach((key) => {
    (chosenByKey.get(key) || []).forEach((s) => out.push(s));
  });
  return out;
}

module.exports = { computePreview, buildMergedSegments, originIdsOf };
