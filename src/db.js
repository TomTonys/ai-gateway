'use strict';

/**
 * 持久化层 —— SQLite（better-sqlite3，同步 API，零原生异步开销）
 *
 * 设计:
 *  - data/gateway.db 单一 SQLite 文件，WAL 模式（崩溃安全、并发读）
 *  - 启动时自动完成一次性 JSON→SQLite 迁移（旧 data/gateway.json），
 *    迁移成功后写 .migrated 标记，旧 JSON 不再参与读写
 *  - 路由层只依赖 Repository API（ProviderRepo / ModelRepo / ...），
 *    存储介质对上层完全透明
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'gateway.db');
const LEGACY_JSON = path.join(DATA_DIR, 'gateway.json');
const MIGRATED_FLAG = path.join(DATA_DIR, '.migrated-sqlite');
const LOG_CAP = 2000;

function now() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function parseDateTime(s) {
  if (!s) return 0;
  const t = new Date(s.replace(' ', 'T')).getTime();
  return Number.isNaN(t) ? 0 : t;
}

// ============================================================
//  旧 JSON 结构（仅迁移用）
// ============================================================
function loadLegacyJson() {
  try {
    if (fs.existsSync(LEGACY_JSON)) {
      return JSON.parse(fs.readFileSync(LEGACY_JSON, 'utf8'));
    }
  } catch (e) {
    console.error('[db] 旧 JSON 读取失败（忽略，使用空模板）:', e.message);
  }
  return {
    seq: { provider: 0, model: 0, custom_model: 0, member: 0, log: 0 },
    providers: [], models: [], custom_models: [], members: [], logs: [],
    test_results: {},
  };
}

// ============================================================
//  建表 + 迁移
// ============================================================
/** 按 Node ABI 存放原生模块的目录（各环境各自编译，互不覆盖） */
const NATIVE_DIR = path.join(__dirname, '..', '.native');

/**
 * 解析本机可用的 better-sqlite3 原生二进制。
 *
 * 背景：原生模块的 .node 文件与 Node ABI 版本（process.versions.modules）
 * 强绑定。本项目的 node_modules 可能被多个不同 Node 版本的环境共享
 * （例如宿主机 systemd 跑 Node 18、容器里跑 Node 24）。此时 node_modules
 * 里只有一份二进制，"谁最后 rebuild 谁赢"，另一边加载会失败甚至段错误。
 *
 * 解决办法：每个环境用 native-build.sh 为**自己的** Node 版本编译一次，
 * 产物按 ABI 命名存放在 .native/ 下。启动时按当前 ABI 精确选取，
 * 多个环境即可共存、互不干扰。
 *
 * @returns {string|null} 匹配当前 ABI 的 .node 路径；null 表示退回默认查找
 */
function resolveNativeBinding() {
  const abi = process.versions.modules;
  const exact = path.join(NATIVE_DIR, `better_sqlite3-node-v${abi}.node`);

  if (fs.existsSync(exact)) return exact;

  // .native/ 已存在但没有匹配当前 ABI 的产物：说明这个项目已启用了
  // 多环境共存机制，此时**不能**退回 node_modules 里的默认二进制
  // （它多半是别的 Node 版本编译的，加载会直接段错误、无法捕获）。
  if (fs.existsSync(NATIVE_DIR)) {
    const have = fs.readdirSync(NATIVE_DIR).filter(f => f.endsWith('.node'));
    console.error('');
    console.error('  ✗ 未找到匹配当前 Node 的 better-sqlite3 原生模块');
    console.error(`    当前 Node ${process.version} (ABI ${abi})`);
    console.error(`    .native/ 中已有: ${have.length ? have.join(', ') : '(空)'}`);
    console.error('');
    console.error('    请在本机执行一次（为该 Node 版本编译）：');
    console.error('');
    console.error('        bash native-build.sh');
    console.error('');
    process.exit(1);
  }

  return null; // 未启用多环境机制 → 用 node_modules 默认二进制
}

/**
 * 打开数据库连接。
 *
 * better-sqlite3 的原生 .node 是在构造 Database 时才真正 dlopen 的，
 * 因此这里才是加载失败（ERR_DLOPEN_FAILED / ABI 不匹配）会抛出的地方。
 * 捕获后给出可执行的修复指引，而不是让用户面对一句难懂的堆栈。
 *
 * nativeBinding 选项可传入具体的 .node 路径，绕过默认查找逻辑，
 * 从而让不同 Node 版本各用各的编译产物（见 resolveNativeBinding）。
 */
function openDatabase(file) {
  const binding = resolveNativeBinding();
  try {
    const Database = require('better-sqlite3');
    return binding ? new Database(file, { nativeBinding: binding }) : new Database(file);
  } catch (e) {
    console.error('');
    console.error('  ✗ 无法加载 better-sqlite3 原生模块');
    console.error(`    当前 Node ${process.version} (ABI ${process.versions.modules})`);
    console.error(`    原因: ${e.message}`);
    console.error('');
    console.error('    该模块与 Node ABI 版本强绑定。若 node_modules 被多个不同');
    console.error('    Node 版本的环境共用，请在本机执行一次：');
    console.error('');
    console.error('        bash native-build.sh');
    console.error('');
    process.exit(1);
  }
}

let db;

function initDatabase() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  db = openDatabase(DB_FILE);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS providers (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      base_url TEXT NOT NULL DEFAULT '',
      api_key TEXT NOT NULL DEFAULT '',
      api_type TEXT NOT NULL DEFAULT 'openai',
      status TEXT NOT NULL DEFAULT 'active',
      remark TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS models (
      id INTEGER PRIMARY KEY,
      provider_id INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
      model_name TEXT NOT NULL,
      display_name TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      request_method TEXT NOT NULL DEFAULT 'chat',
      remark TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(provider_id, model_name)
    );
    CREATE TABLE IF NOT EXISTS custom_models (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL DEFAULT '',
      retry_mode TEXT NOT NULL DEFAULT 'priority',
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS members (
      id INTEGER PRIMARY KEY,
      custom_model_id INTEGER NOT NULL REFERENCES custom_models(id) ON DELETE CASCADE,
      model_id INTEGER NOT NULL REFERENCES models(id) ON DELETE CASCADE,
      priority INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      UNIQUE(custom_model_id, model_id)
    );
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY,
      custom_model TEXT NOT NULL DEFAULT '',
      target_model TEXT NOT NULL DEFAULT '',
      provider_name TEXT NOT NULL DEFAULT '',
      status_code INTEGER NOT NULL DEFAULT 0,
      success INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      error_message TEXT NOT NULL DEFAULT '',
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      cached_tokens INTEGER NOT NULL DEFAULT 0,
      request_snapshot TEXT NOT NULL DEFAULT '',
      request_body TEXT NOT NULL DEFAULT '',
      response_body TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_logs_created ON logs(created_at);
    CREATE TABLE IF NOT EXISTS test_results (
      model_id INTEGER PRIMARY KEY REFERENCES models(id) ON DELETE CASCADE,
      ok INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      status INTEGER NOT NULL DEFAULT 0,
      error TEXT NOT NULL DEFAULT '',
      tested_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const legacy = loadLegacyJson();

  // 增量迁移：给已存在的旧库补列（SQLite 无 IF NOT EXISTS for ADD COLUMN）
  const logCols = db.prepare('PRAGMA table_info(logs)').all().map(c => c.name);
  if (!logCols.includes('request_body')) {
    db.exec("ALTER TABLE logs ADD COLUMN request_body TEXT NOT NULL DEFAULT ''");
  }
  if (!logCols.includes('response_body')) {
    db.exec("ALTER TABLE logs ADD COLUMN response_body TEXT NOT NULL DEFAULT ''");
  }

  // 一次性迁移：旧 JSON 有数据且 SQLite 是空的 → 导入
  const hasRows = db.prepare(
    'SELECT (SELECT count(*) FROM providers)+(SELECT count(*) FROM models)+(SELECT count(*) FROM custom_models)+(SELECT count(*) FROM members)+(SELECT count(*) FROM logs) AS n'
  ).get().n > 0;

  if (!hasRows && fs.existsSync(LEGACY_JSON)) {
    const t = db.transaction(() => {
      const insProv = db.prepare(
        'INSERT INTO providers (id,name,base_url,api_key,api_type,status,remark,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)');
      for (const p of legacy.providers || []) {
        insProv.run(p.id, p.name, p.base_url || '', p.api_key || '', p.api_type || 'openai',
          p.status || 'active', p.remark || '', p.created_at || now(), p.updated_at || p.created_at || now());
      }
      const insModel = db.prepare(
        'INSERT INTO models (id,provider_id,model_name,display_name,status,request_method,remark,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)');
      for (const m of legacy.models || []) {
        insModel.run(m.id, m.provider_id, m.model_name, m.display_name || m.model_name,
          m.status || 'active', m.request_method || 'chat', m.remark || '',
          m.created_at || now(), m.updated_at || m.created_at || now());
      }
      const insCustom = db.prepare(
        'INSERT INTO custom_models (id,name,description,retry_mode,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)');
      for (const c of legacy.custom_models || []) {
        insCustom.run(c.id, c.name, c.description || '', c.retry_mode || 'priority',
          c.status || 'active', c.created_at || now(), c.updated_at || c.created_at || now());
      }
      const insMember = db.prepare(
        'INSERT INTO members (id,custom_model_id,model_id,priority,enabled,created_at) VALUES (?,?,?,?,?,?)');
      for (const mm of legacy.members || []) {
        insMember.run(mm.id, mm.custom_model_id, mm.model_id, mm.priority || 0,
          mm.enabled === undefined ? 1 : (mm.enabled ? 1 : 0), mm.created_at || now());
      }
      const insLog = db.prepare(
        'INSERT INTO logs (id,custom_model,target_model,provider_name,status_code,success,duration_ms,error_message,prompt_tokens,completion_tokens,total_tokens,cached_tokens,request_snapshot,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
      for (const l of (legacy.logs || []).slice(0, LOG_CAP)) {
        insLog.run(l.id, l.custom_model || '', l.target_model || '', l.provider_name || '',
          l.status_code || 0, l.success ? 1 : 0, l.duration_ms || 0, l.error_message || '',
          l.prompt_tokens || 0, l.completion_tokens || 0, l.total_tokens || 0, l.cached_tokens || 0,
          l.request_snapshot ? JSON.stringify(l.request_snapshot) : '', l.created_at || now());
      }
      const insTest = db.prepare(
        'INSERT INTO test_results (model_id,ok,duration_ms,status,error,tested_at) VALUES (?,?,?,?,?,?)');
      for (const tr of Object.values(legacy.test_results || {})) {
        insTest.run(tr.model_id, tr.ok ? 1 : 0, tr.duration_ms || 0, tr.status || 0,
          tr.error || '', tr.tested_at || now());
      }
      // 元数据（seq 与旧版兼容保留）
      const insMeta = db.prepare('INSERT OR REPLACE INTO meta (key,value) VALUES (?,?)');
      for (const [k, v] of Object.entries(legacy.seq || {})) insMeta.run('seq_' + k, String(v));
      insMeta.run('migrated_from', new Date().toISOString());
    });
    t();
    fs.writeFileSync(MIGRATED_FLAG, JSON.stringify({ at: new Date().toISOString(), legacy: 'data/gateway.json' }, null, 2));
    console.log('[db] 已将旧 JSON 数据迁移到 SQLite（data/gateway.db）');
  }
}

initDatabase();

// ============================================================
//  通用取数助手
// ============================================================
const q = {
  providers: () => db.prepare('SELECT * FROM providers ORDER BY id').all()
    .map(p => ({
      ...p,
      model_count: db.prepare('SELECT count(*) n FROM models WHERE provider_id=?').get(p.id).n,
    })),
  models: () => db.prepare('SELECT * FROM models ORDER BY id').all(),
  customModels: () => db.prepare('SELECT * FROM custom_models ORDER BY id').all(),
  members: () => db.prepare('SELECT * FROM members ORDER BY id').all(),
  logsDesc: () => db.prepare('SELECT * FROM logs ORDER BY id DESC').all()
    .map(l => ({
      id: l.id,
      custom_model: l.custom_model,
      target_model: l.target_model,
      provider_name: l.provider_name,
      status_code: l.status_code,
      success: l.success,
      duration_ms: l.duration_ms,
      error_message: l.error_message,
      prompt_tokens: l.prompt_tokens,
      completion_tokens: l.completion_tokens,
      total_tokens: l.total_tokens,
      cached_tokens: l.cached_tokens,
      request_snapshot: l.request_snapshot ? JSON.parse(l.request_snapshot) : null,
      created_at: l.created_at,
    })),
  nextId: (table) =>
    Number(db.prepare('SELECT COALESCE(MAX(id),0)+1 AS n FROM ' + table).get().n),
};

// 日志保持有界（与旧版 LOG_CAP 一致）
function pruneLogs() {
  const excess = db.prepare('SELECT count(*) n FROM logs').get().n - LOG_CAP;
  if (excess > 0) {
    db.prepare('DELETE FROM logs WHERE id IN (SELECT id FROM logs ORDER BY id DESC LIMIT ?)').run(excess);
  }
}

// ============================================================
//  Providers
// ============================================================
const ProviderRepo = {
  list() {
    return q.providers().reverse();
  },

  get(id) {
    const p = db.prepare('SELECT * FROM providers WHERE id=?').get(Number(id));
    if (!p) return null;
    p.model_count = db.prepare('SELECT count(*) n FROM models WHERE provider_id=?').get(p.id).n;
    return p;
  },

  create({ name, base_url, api_key, api_type, remark, status }) {
    if (db.prepare('SELECT 1 FROM providers WHERE name=?').get(name)) {
      throw new Error(`Provider name "${name}" already exists`);
    }
    const id = q.nextId('providers');
    const ts = now();
    db.prepare(
      'INSERT INTO providers (id,name,base_url,api_key,api_type,status,remark,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)'
    ).run(id, name, base_url || '', api_key || '', api_type || 'openai', status || 'active', remark || '', ts, ts);
    return this.get(id);
  },

  update(id, patch) {
    const p = this.get(id);
    if (!p) return false;
    if (patch.name && patch.name !== p.name) {
      if (db.prepare('SELECT 1 FROM providers WHERE name=? AND id!=?').get(patch.name, Number(id))) {
        throw new Error(`Provider name "${patch.name}" already exists`);
      }
    }
    db.prepare(
      'UPDATE providers SET name=?, base_url=?, api_key=?, api_type=?, status=?, remark=?, updated_at=? WHERE id=?'
    ).run(
      patch.name ?? p.name,
      patch.base_url ?? p.base_url,
      patch.api_key ?? p.api_key,
      patch.api_type ?? p.api_type,
      patch.status ?? p.status,
      patch.remark ?? p.remark,
      now(),
      Number(id),
    );
    return true;
  },

  delete(id) {
    const n = db.prepare('SELECT 1 FROM providers WHERE id=?').get(Number(id));
    if (!n) return false;
    const p = db.prepare('SELECT name FROM providers WHERE id=?').get(Number(id));
    // CASCADE 自动清理该供应商的 models 与 members；历史日志按旧版行为清理
    db.prepare('DELETE FROM providers WHERE id=?').run(Number(id));
    db.prepare('DELETE FROM logs WHERE provider_name=?').run(p ? p.name : '');
    return true;
  },
};

// ============================================================
//  Models
// ============================================================
const ModelRepo = {
  list(providerId) {
    let rows;
    if (providerId) {
      rows = db.prepare('SELECT * FROM models WHERE provider_id=? ORDER BY id DESC').all(Number(providerId));
    } else {
      rows = db.prepare('SELECT * FROM models ORDER BY id DESC').all();
    }
    return rows.map(m => {
      const p = db.prepare('SELECT name FROM providers WHERE id=?').get(m.provider_id);
      return { ...m, provider_name: p ? p.name : '(deleted)' };
    });
  },

  get(id) {
    const m = db.prepare('SELECT * FROM models WHERE id=?').get(Number(id));
    if (!m) return null;
    const p = db.prepare('SELECT * FROM providers WHERE id=?').get(m.provider_id);
    return {
      ...m,
      provider_name: p ? p.name : '(deleted)',
      base_url: p ? p.base_url : '',
      api_key: p ? p.api_key : '',
      api_type: p ? p.api_type : '',
    };
  },

  create({ provider_id, model_name, display_name, remark, request_method }) {
    const clash = db.prepare(
      'SELECT 1 FROM models WHERE provider_id=? AND model_name=?').get(Number(provider_id), model_name);
    if (clash) throw new Error(`Model "${model_name}" already exists for this provider`);
    if (!db.prepare('SELECT 1 FROM providers WHERE id=?').get(Number(provider_id))) {
      throw new Error('Provider not found');
    }
    const id = q.nextId('models');
    const ts = now();
    db.prepare(
      'INSERT INTO models (id,provider_id,model_name,display_name,status,request_method,remark,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)'
    ).run(id, Number(provider_id), model_name, display_name || model_name, 'active',
      request_method === 'responses' ? 'responses' : 'chat', remark || '', ts, ts);
    return this.get(id);
  },

  update(id, patch) {
    const m = db.prepare('SELECT * FROM models WHERE id=?').get(Number(id));
    if (!m) return false;
    if (patch.model_name && patch.model_name !== m.model_name) {
      const clash = db.prepare(
        'SELECT 1 FROM models WHERE provider_id=? AND model_name=? AND id!=?').get(m.provider_id, patch.model_name, Number(id));
      if (clash) throw new Error(`Model "${patch.model_name}" already exists for this provider`);
    }
    db.prepare(
      'UPDATE models SET model_name=?, display_name=?, status=?, request_method=?, remark=?, updated_at=? WHERE id=?'
    ).run(
      patch.model_name ?? m.model_name,
      patch.display_name ?? m.display_name,
      patch.status ?? m.status,
      patch.request_method === undefined ? (m.request_method || 'chat') : patch.request_method,
      patch.remark ?? m.remark,
      now(),
      Number(id),
    );
    return true;
  },

  delete(id) {
    const n = db.prepare('SELECT 1 FROM models WHERE id=?').get(Number(id));
    if (!n) return false;
    db.prepare('DELETE FROM models WHERE id=?').run(Number(id)); // CASCADE 清 members/test_results
    return true;
  },
};

// ============================================================
//  Custom Models (融合模型)
// ============================================================
const CustomModelRepo = {
  list() {
    return db.prepare('SELECT * FROM custom_models ORDER BY id DESC').all()
      .map(cm => ({
        ...cm,
        member_count: db.prepare('SELECT count(*) n FROM members WHERE custom_model_id=?').get(cm.id).n,
      }));
  },

  get(id) {
    return db.prepare('SELECT * FROM custom_models WHERE id=?').get(Number(id)) || null;
  },

  getByName(name) {
    return db.prepare("SELECT * FROM custom_models WHERE name=? AND status='active'").get(name) || null;
  },

  create({ name, description, retry_mode, status }) {
    if (db.prepare('SELECT 1 FROM custom_models WHERE name=?').get(name)) {
      throw new Error(`Custom model name "${name}" already exists`);
    }
    const id = q.nextId('custom_models');
    const ts = now();
    db.prepare(
      'INSERT INTO custom_models (id,name,description,retry_mode,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)'
    ).run(id, name, description || '', retry_mode || 'priority', status || 'active', ts, ts);
    return this.get(id);
  },

  update(id, patch) {
    const cm = this.get(id);
    if (!cm) return false;
    if (patch.name && patch.name !== cm.name) {
      if (db.prepare('SELECT 1 FROM custom_models WHERE name=? AND id!=?').get(patch.name, Number(id))) {
        throw new Error(`Custom model name "${patch.name}" already exists`);
      }
    }
    db.prepare(
      'UPDATE custom_models SET name=?, description=?, retry_mode=?, status=?, updated_at=? WHERE id=?'
    ).run(
      patch.name ?? cm.name,
      patch.description ?? cm.description,
      patch.retry_mode ?? cm.retry_mode,
      patch.status ?? cm.status,
      now(),
      Number(id),
    );
    return true;
  },

  delete(id) {
    const n = db.prepare('SELECT 1 FROM custom_models WHERE id=?').get(Number(id));
    if (!n) return false;
    db.prepare('DELETE FROM custom_models WHERE id=?').run(Number(id)); // CASCADE 清 members
    return true;
  },

  /**
   * 获取融合模型成员（含模型 + 供应商联查信息）
   * retry_mode=priority: 按 priority 升序
   * retry_mode=sequence: 按添加顺序（id 升序）
   */
  getMembers(customModelId) {
    const cm = this.get(customModelId);
    let rows;
    if (cm && cm.retry_mode === 'sequence') {
      rows = db.prepare(
        'SELECT * FROM members WHERE custom_model_id=? ORDER BY id ASC').all(Number(customModelId));
    } else {
      rows = db.prepare(
        'SELECT * FROM members WHERE custom_model_id=? ORDER BY priority ASC, id ASC').all(Number(customModelId));
    }
    return rows
      .map(mm => {
        const m = db.prepare('SELECT * FROM models WHERE id=?').get(mm.model_id);
        const p = m ? db.prepare('SELECT * FROM providers WHERE id=?').get(m.provider_id) : null;
        return {
          member_id: mm.id,
          priority: mm.priority,
          enabled: mm.enabled,
          model_id: mm.model_id,
          model_name: m ? m.model_name : '(deleted)',
          display_name: m ? m.display_name : '(deleted)',
          model_status: m ? m.status : 'inactive',
          request_method: m ? (m.request_method || 'chat') : 'chat',
          provider_id: p ? p.id : null,
          provider_name: p ? p.name : '(deleted)',
          base_url: p ? p.base_url : '',
          api_key: p ? p.api_key : '',
          api_type: p ? p.api_type : 'openai',
          provider_status: p ? p.status : 'inactive',
        };
      })
      .filter(m => m.provider_id); // 供应商已删除的成员剔除
  },

  addMember({ custom_model_id, model_id, priority }) {
    const cm = this.get(custom_model_id);
    if (!cm) throw new Error('Custom model not found');
    if (!db.prepare('SELECT 1 FROM models WHERE id=?').get(Number(model_id))) throw new Error('Model not found');
    const existing = db.prepare(
      'SELECT * FROM members WHERE custom_model_id=? AND model_id=?').get(Number(custom_model_id), Number(model_id));
    if (existing) {
      db.prepare('UPDATE members SET priority=?, enabled=1 WHERE id=?')
        .run(Number(priority ?? existing.priority), existing.id);
    } else {
      db.prepare('INSERT INTO members (id,custom_model_id,model_id,priority,enabled,created_at) VALUES (?,?,?,?,?,?)')
        .run(q.nextId('members'), Number(custom_model_id), Number(model_id),
          Number(priority ?? 0), 1, now());
    }
  },

  updateMember(memberId, patch) {
    const mm = db.prepare('SELECT * FROM members WHERE id=?').get(Number(memberId));
    if (!mm) return false;
    db.prepare('UPDATE members SET priority=?, enabled=? WHERE id=?')
      .run(
        patch.priority === undefined ? mm.priority : Number(patch.priority),
        patch.enabled === undefined ? mm.enabled : (patch.enabled ? 1 : 0),
        mm.id,
      );
    return true;
  },

  removeMember(memberId) {
    const n = db.prepare('DELETE FROM members WHERE id=?').run(Number(memberId));
    return n.changes > 0;
  },
};

// ============================================================
//  Request Logs
// ============================================================
const LogRepo = {
  create({ custom_model, target_model, provider_name, status_code, success, duration_ms, error_message, usage, request_snapshot, request_body, response_body }) {
    const id = q.nextId('logs');
    db.prepare(
      'INSERT INTO logs (id,custom_model,target_model,provider_name,status_code,success,duration_ms,error_message,prompt_tokens,completion_tokens,total_tokens,cached_tokens,request_snapshot,request_body,response_body,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
    ).run(
      id,
      custom_model || '',
      target_model || '',
      provider_name || '',
      status_code || 0,
      success ? 1 : 0,
      duration_ms || 0,
      error_message || '',
      usage ? (usage.prompt_tokens || 0) : 0,
      usage ? (usage.completion_tokens || 0) : 0,
      usage ? (usage.total_tokens || 0) : 0,
      usage ? (usage.cached_tokens || 0) : 0,
      request_snapshot ? JSON.stringify(request_snapshot) : '',
      request_body || '',
      response_body || '',
      now(),
    );
    pruneLogs();
    return this.get(id);
  },

  /** 单条日志完整详情（含请求体/响应体原文，供日志详情弹窗使用） */
  get(id) {
    const l = db.prepare('SELECT * FROM logs WHERE id=?').get(Number(id));
    if (!l) return null;
    return {
      id: l.id,
      custom_model: l.custom_model,
      target_model: l.target_model,
      provider_name: l.provider_name,
      status_code: l.status_code,
      success: l.success,
      duration_ms: l.duration_ms,
      error_message: l.error_message,
      prompt_tokens: l.prompt_tokens,
      completion_tokens: l.completion_tokens,
      total_tokens: l.total_tokens,
      cached_tokens: l.cached_tokens,
      request_snapshot: l.request_snapshot ? JSON.parse(l.request_snapshot) : null,
      request_body: l.request_body || '',
      response_body: l.response_body || '',
      created_at: l.created_at,
    };
  },

  /** 更新指定日志的响应体（流式场景：透传完成后才能拿到完整响应） */
  updateResponseBody(id, response_body) {
    db.prepare('UPDATE logs SET response_body=? WHERE id=?').run(response_body || '', Number(id));
  },

  /** 更新最近一条日志的 usage（流式场景：透传完成后才拿到 usage） */
  updateLastUsage({ prompt_tokens, completion_tokens, total_tokens, cached_tokens }) {
    const row = db.prepare('SELECT id FROM logs ORDER BY id DESC LIMIT 1').get();
    if (!row) return;
    db.prepare(
      'UPDATE logs SET prompt_tokens=?, completion_tokens=?, total_tokens=?, cached_tokens=? WHERE id=?'
    ).run(
      prompt_tokens || 0, completion_tokens || 0,
      total_tokens || (prompt_tokens || 0) + (completion_tokens || 0),
      cached_tokens || 0,
      row.id,
    );
  },

  /** 列表：不返回 request_body/response_body 大字段（体积控制），详情走 get(id) */
  list(limit = 50, offset = 0, filter = null) {
    let sql = 'SELECT id,custom_model,target_model,provider_name,status_code,success,duration_ms,error_message,prompt_tokens,completion_tokens,total_tokens,cached_tokens,request_snapshot,created_at FROM logs';
    const params = [];
    if (filter !== null && filter !== undefined) {
      sql += ' WHERE success = ?';
      params.push(filter === '1' ? 1 : 0);
    }
    sql += ' ORDER BY id DESC LIMIT ? OFFSET ?';
    params.push(Number(limit), Number(offset));
    return db.prepare(sql).all(...params)
      .map(l => ({
        id: l.id,
        custom_model: l.custom_model,
        target_model: l.target_model,
        provider_name: l.provider_name,
        status_code: l.status_code,
        success: l.success,
        duration_ms: l.duration_ms,
        error_message: l.error_message,
        prompt_tokens: l.prompt_tokens,
        completion_tokens: l.completion_tokens,
        total_tokens: l.total_tokens,
        cached_tokens: l.cached_tokens,
        request_snapshot: l.request_snapshot ? JSON.parse(l.request_snapshot) : null,
        created_at: l.created_at,
      }));
  },

  count(filter = null) {
    let sql = 'SELECT count(*) n FROM logs';
    const params = [];
    if (filter !== null && filter !== undefined) {
      sql += ' WHERE success = ?';
      params.push(filter === '1' ? 1 : 0);
    }
    return db.prepare(sql).get(...params).n;
  },

  stats() {
    const { total, success } = db.prepare(
      'SELECT count(*) total, sum(CASE WHEN success=1 THEN 1 ELSE 0 END) success FROM logs').get();
    return { total: total || 0, success: success || 0, failed: (total || 0) - (success || 0) };
  },

  /**
   * Token 消耗聚合统计（仅统计成功请求；失败请求无 usage）
   * @param {number} [days] 时间窗口（天），默认全部
   */
  tokenStats(days = 0) {
    const rows = q.logsDesc().filter(l => l.success === 1)
      .filter(l => days <= 0 || parseDateTime(l.created_at) >= Date.now() - days * 86400000);
    const sum = { prompt: 0, completion: 0, total: 0, cached: 0, requests: rows.length };
    const byModel = {};
    const byProvider = {};
    for (const l of rows) {
      sum.prompt += l.prompt_tokens;
      sum.completion += l.completion_tokens;
      sum.total += l.total_tokens;
      sum.cached += l.cached_tokens;
      const mk = l.target_model || '(unknown)';
      byModel[mk] = byModel[mk] || { requests: 0, prompt: 0, completion: 0, total: 0, cached: 0 };
      byModel[mk].requests += 1;
      byModel[mk].prompt += l.prompt_tokens;
      byModel[mk].completion += l.completion_tokens;
      byModel[mk].total += l.total_tokens;
      byModel[mk].cached += l.cached_tokens;
      const pk = l.provider_name || '(unknown)';
      byProvider[pk] = byProvider[pk] || { requests: 0, prompt: 0, completion: 0, total: 0, cached: 0 };
      byProvider[pk].requests += 1;
      byProvider[pk].prompt += l.prompt_tokens;
      byProvider[pk].completion += l.completion_tokens;
      byProvider[pk].total += l.total_tokens;
      byProvider[pk].cached += l.cached_tokens;
    }
    return { total: sum, by_model: byModel, by_provider: byProvider, window_days: days };
  },
};

// ============================================================
//  Model Connectivity Test Results
// ============================================================
const TestResultRepo = {
  all() {
    const out = {};
    for (const t of db.prepare('SELECT * FROM test_results').all()) {
      out[t.model_id] = {
        model_id: t.model_id,
        ok: t.ok,
        duration_ms: t.duration_ms,
        status: t.status,
        error: t.error,
        tested_at: t.tested_at,
      };
    }
    return out;
  },
  get(modelId) {
    return this.all()[Number(modelId)] || null;
  },
  set(modelId, { duration_ms, ok, status, error }) {
    db.prepare(
      'INSERT INTO test_results (model_id,ok,duration_ms,status,error,tested_at) VALUES (?,?,?,?,?,?) ' +
      'ON CONFLICT(model_id) DO UPDATE SET ok=excluded.ok, duration_ms=excluded.duration_ms, status=excluded.status, error=excluded.error, tested_at=excluded.tested_at'
    ).run(Number(modelId), ok ? 1 : 0, duration_ms || 0, status || 0, error || '', now());
  },
  remove(modelId) {
    db.prepare('DELETE FROM test_results WHERE model_id=?').run(Number(modelId));
  },
};

module.exports = { ProviderRepo, ModelRepo, CustomModelRepo, LogRepo, TestResultRepo };
