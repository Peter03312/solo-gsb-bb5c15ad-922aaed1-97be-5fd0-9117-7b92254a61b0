'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'app.db');

let db;

function getDb() {
  if (db) return db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initSchema(db);
  return db;
}

function initSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS manuscripts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    NOT NULL,
      raw_srt     TEXT    NOT NULL,           -- 原始 SRT 全文，只读
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS segments (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      manuscript_id INTEGER NOT NULL REFERENCES manuscripts(id) ON DELETE CASCADE,
      branch        TEXT    NOT NULL,         -- 'origin' | 'a' | 'b' | 'merged'
      ord           INTEGER NOT NULL,         -- 分支内从 1 开始的连续序号
      start_ms      INTEGER NOT NULL,
      end_ms        INTEGER NOT NULL,
      text          TEXT    NOT NULL,
      origin_ids    TEXT    NOT NULL DEFAULT '[]',  -- 来源原稿片段 id 的 JSON 数组
      UNIQUE (manuscript_id, branch, ord)
    );
    CREATE INDEX IF NOT EXISTS idx_segments_lookup
      ON segments (manuscript_id, branch, ord);

    CREATE TABLE IF NOT EXISTS branches (
      manuscript_id INTEGER NOT NULL REFERENCES manuscripts(id) ON DELETE CASCADE,
      branch        TEXT    NOT NULL,         -- 'a' | 'b'
      created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (manuscript_id, branch)
    );

    CREATE TABLE IF NOT EXISTS merges (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      manuscript_id INTEGER NOT NULL REFERENCES manuscripts(id) ON DELETE CASCADE,
      resolved      TEXT    NOT NULL,         -- 冲突解决结果的 JSON
      created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

module.exports = { getDb, DB_PATH, DATA_DIR };

// `node server/db.js` 时直接创建并初始化数据库
if (require.main === module) {
  getDb();
  console.log(`数据库已初始化: ${DB_PATH}`);
}
