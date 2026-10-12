'use strict';

/**
 * 持久化层 —— 纯 JS JSON 文件存储（零原生依赖）
 *
 * 设计:
 *  - 单一数据文件 data/gateway.json，原子写入（tmp + rename）
 *  - 进程内单线程内存缓存，所有读操作走内存
 *  - 日志有界（保留最近 500 条），防止文件无限膨胀
 *  - 保持与数据库版本完全相同的 Repository API
 */

const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '..', 'data', 'gateway.json');
const LOG_CAP = 2000;

function defaultData() {
  return {
    seq: { provider: 0, model: 0, custom_model: 0, member: 0, log: 0 },
    providers: [],
    models: [],
    custom_models: [],
    members: [],   // { id, custom_model_id, model_id, priority, enabled, created_at }
    logs: [],
  };
}

function load() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      return { ...defaultData(), ...parsed };
    }
  } catch (e) {
    console.error('[db] Failed to load data file, starting fresh:', e.message);
  }
  return defaultData();
}

let store = load();
const dir = path.dirname(DATA_FILE);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

function persist() {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 1));
  fs.renameSync(tmp, DATA_FILE);
}

function now() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function nextId(key) {
  store.seq[key] += 1;
  return store.seq[key];
}

// ============================================================
//  Providers
// ============================================================
const ProviderRepo = {
  list() {
    return store.providers.map(p => ({
      ...p,
      model_count: store.models.filter(m => m.provider_id === p.id).length,
    }));
  },

  get(id) {
    return store.providers.find(p => p.id === Number(id)) || null;
  },

  create({ name, base_url, api_key, api_type, remark, status }) {
    if (store.providers.some(p => p.name === name)) {
      throw new Error(`Provider name "${name}" already exists`);
    }
    const p = {
      id: nextId('provider'),
      name,
      base_url,
      api_key: api_key || '',
      api_type: api_type || 'openai',
      status: status || 'active',
      remark: remark || '',
      created_at: now(),
      updated_at: now(),
    };
    store.providers.push(p);
    persist();
    return p;
  },

  update(id, patch) {
    const p = this.get(id);
    if (!p) return false;
    if (patch.name && patch.name !== p.name) {
      if (store.providers.some(x => x.name === patch.name)) {
        throw new Error(`Provider name "${patch.name}" already exists`);
      }
    }
    Object.assign(p, {
      name: patch.name ?? p.name,
      base_url: patch.base_url ?? p.base_url,
      api_key: patch.api_key ?? p.api_key,
      api_type: patch.api_type ?? p.api_type,
      status: patch.status ?? p.status,
      remark: patch.remark ?? p.remark,
      updated_at: now(),
    });
    persist();
    return true;
  },

  delete(id) {
    const before = store.providers.length;
    const target = store.providers.find(p => p.id === Number(id));
    if (!target) return false;
    store.providers = store.providers.filter(p => p.id !== Number(id));
    // 级联删除其模型 + 相关融合成员
    const deadModelIds = new Set(store.models.filter(m => m.provider_id === target.id).map(m => m.id));
    store.models = store.models.filter(m => !deadModelIds.has(m.id));
    store.members = store.members.filter(mm => !deadModelIds.has(mm.model_id));
    store.logs = store.logs.filter(l => l.provider_name !== target.name);
    if (store.providers.length === before - 1) persist();
    return true;
  }
};

// ============================================================
//  Models
// ============================================================
const ModelRepo = {
  list(providerId) {
    const rows = providerId
      ? store.models.filter(m => m.provider_id === Number(providerId))
      : store.models;
    return rows.map(m => {
      const p = store.providers.find(x => x.id === m.provider_id);
      return { ...m, provider_name: p ? p.name : '(deleted)' };
    }).reverse();
  },

  get(id) {
    const m = store.models.find(x => x.id === Number(id));
    if (!m) return null;
    const p = store.providers.find(x => x.id === m.provider_id);
    return {
      ...m,
      provider_name: p ? p.name : '(deleted)',
      base_url: p ? p.base_url : '',
      api_key: p ? p.api_key : '',
      api_type: p ? p.api_type : '',
    };
  },

  create({ provider_id, model_name, display_name, remark, request_method }) {
    if (store.models.some(m => m.provider_id === Number(provider_id) && m.model_name === model_name)) {
      throw new Error(`Model "${model_name}" already exists for this provider`);
    }
    const m = {
      id: nextId('model'),
      provider_id: Number(provider_id),
      model_name,
      display_name: display_name || model_name,
      status: 'active',
      request_method: request_method === 'responses' ? 'responses' : 'chat',
      remark: remark || '',
      created_at: now(),
      updated_at: now(),
    };
    store.models.push(m);
    persist();
    return m;
  },

  update(id, patch) {
    const m = store.models.find(x => x.id === Number(id));
    if (!m) return false;
    if (patch.model_name && patch.model_name !== m.model_name) {
      const clash = store.models.some(x =>
        x.id !== m.id && x.provider_id === m.provider_id && x.model_name === patch.model_name);
      if (clash) throw new Error(`Model "${patch.model_name}" already exists for this provider`);
    }
    Object.assign(m, {
      model_name: patch.model_name ?? m.model_name,
      display_name: patch.display_name ?? m.display_name,
      status: patch.status ?? m.status,
      request_method: patch.request_method === undefined ? (m.request_method || 'chat') : patch.request_method,
      remark: patch.remark ?? m.remark,
      updated_at: now(),
    });
    persist();
    return true;
  },

  delete(id) {
    const target = store.models.find(m => m.id === Number(id));
    if (!target) return false;
    store.models = store.models.filter(m => m.id !== Number(id));
    store.members = store.members.filter(mm => mm.model_id !== Number(id));
    persist();
    return true;
  }
};

// ============================================================
//  Custom Models (融合模型)
// ============================================================
const CustomModelRepo = {
  list() {
    return store.custom_models.map(cm => ({
      ...cm,
      member_count: store.members.filter(mm => mm.custom_model_id === cm.id).length,
    })).reverse();
  },

  get(id) {
    return store.custom_models.find(cm => cm.id === Number(id)) || null;
  },

  getByName(name) {
    return store.custom_models.find(cm => cm.name === name && cm.status === 'active') || null;
  },

  create({ name, description, retry_mode, status }) {
    if (store.custom_models.some(cm => cm.name === name)) {
      throw new Error(`Custom model name "${name}" already exists`);
    }
    const cm = {
      id: nextId('custom_model'),
      name,
      description: description || '',
      retry_mode: retry_mode || 'priority',
      status: status || 'active',
      created_at: now(),
      updated_at: now(),
    };
    store.custom_models.push(cm);
    persist();
    return cm;
  },

  update(id, patch) {
    const cm = this.get(id);
    if (!cm) return false;
    if (patch.name && patch.name !== cm.name) {
      if (store.custom_models.some(x => x.name === patch.name)) {
        throw new Error(`Custom model name "${patch.name}" already exists`);
      }
    }
    Object.assign(cm, {
      name: patch.name ?? cm.name,
      description: patch.description ?? cm.description,
      retry_mode: patch.retry_mode ?? cm.retry_mode,
      status: patch.status ?? cm.status,
      updated_at: now(),
    });
    persist();
    return true;
  },

  delete(id) {
    const target = store.custom_models.find(cm => cm.id === Number(id));
    if (!target) return false;
    store.custom_models = store.custom_models.filter(cm => cm.id !== Number(id));
    store.members = store.members.filter(mm => mm.custom_model_id !== Number(id));
    persist();
    return true;
  },

  /**
   * 获取融合模型成员（含模型 + 供应商联查信息）
   * retry_mode=priority: 按 priority 升序
   * retry_mode=sequence: 按添加顺序（created_at / id）
   */
  getMembers(customModelId) {
    const cm = this.get(customModelId);
    const members = store.members
      .filter(mm => mm.custom_model_id === Number(customModelId))
      .map(mm => {
        const m = store.models.find(x => x.id === mm.model_id);
        const p = m ? store.providers.find(x => x.id === m.provider_id) : null;
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

    if (cm && cm.retry_mode === 'sequence') {
      members.sort((a, b) => a.member_id - b.member_id);
    } else {
      members.sort((a, b) => (a.priority - b.priority) || (a.member_id - b.member_id));
    }
    return members;
  },

  addMember({ custom_model_id, model_id, priority }) {
    const cm = this.get(custom_model_id);
    if (!cm) throw new Error('Custom model not found');
    if (!store.models.some(m => m.id === Number(model_id))) throw new Error('Model not found');
    const existing = store.members.find(mm => mm.custom_model_id === Number(custom_model_id) && mm.model_id === Number(model_id));
    if (existing) {
      existing.priority = Number(priority ?? existing.priority);
      existing.enabled = 1;
    } else {
      store.members.push({
        id: nextId('member'),
        custom_model_id: Number(custom_model_id),
        model_id: Number(model_id),
        priority: Number(priority ?? 0),
        enabled: 1,
        created_at: now(),
      });
    }
    persist();
  },

  updateMember(memberId, patch) {
    const mm = store.members.find(x => x.id === Number(memberId));
    if (!mm) return false;
    if (patch.priority !== undefined) mm.priority = Number(patch.priority);
    if (patch.enabled !== undefined) mm.enabled = Number(patch.enabled);
    persist();
    return true;
  },

  removeMember(memberId) {
    const target = store.members.find(mm => mm.id === Number(memberId));
    if (!target) return false;
    store.members = store.members.filter(mm => mm.id !== Number(memberId));
    persist();
    return true;
  }
};

// ============================================================
//  Request Logs
// ============================================================
const LogRepo = {
  create({ custom_model, target_model, provider_name, status_code, success, duration_ms, error_message, usage }) {
    store.logs.unshift({
      id: nextId('log'),
      custom_model: custom_model || '',
      target_model: target_model || '',
      provider_name: provider_name || '',
      status_code: status_code || 0,
      success: success ? 1 : 0,
      duration_ms: duration_ms || 0,
      error_message: error_message || '',
      prompt_tokens: usage ? (usage.prompt_tokens || 0) : 0,
      completion_tokens: usage ? (usage.completion_tokens || 0) : 0,
      total_tokens: usage ? (usage.total_tokens || 0) : 0,
      cached_tokens: usage ? (usage.cached_tokens || 0) : 0,
      created_at: now(),
    });
    if (store.logs.length > LOG_CAP) store.logs.length = LOG_CAP;
    persist();
    return store.logs[0];
  },

  /** 更新最近一条日志的 usage（流式场景：透传完成后才拿到 usage） */
  updateLastUsage({ prompt_tokens, completion_tokens, total_tokens, cached_tokens }) {
    const log = store.logs[0];
    if (!log) return;
    log.prompt_tokens = prompt_tokens || 0;
    log.completion_tokens = completion_tokens || 0;
    log.total_tokens = total_tokens || 0;
    log.cached_tokens = cached_tokens || 0;
    persist();
  },

  list(limit = 50, offset = 0, filter = null) {
    let rows = store.logs;
    if (filter !== null) {
      rows = rows.filter(l => (filter === '1' ? l.success === 1 : l.success === 0));
    }
    return rows.slice(offset, offset + limit);
  },

  count(filter = null) {
    if (filter === null) return store.logs.length;
    return store.logs.filter(l => (filter === '1' ? l.success === 1 : l.success === 0)).length;
  },

  stats() {
    const total = store.logs.length;
    const success = store.logs.filter(l => l.success === 1).length;
    return { total, success, failed: total - success };
  },

  /**
   * Token 消耗聚合统计（仅统计成功请求；失败请求无 usage）
   * @param {number} [days] 时间窗口（天），默认全部
   */
  tokenStats(days = 0) {
    const logs = store.logs;
    const since = days > 0 ? Date.now() - days * 86400000 : 0;
    const rows = logs.filter(l => l.success === 1 && (!since || parseDateTime(l.created_at) >= since));
    const sum = { prompt: 0, completion: 0, total: 0, cached: 0, requests: rows.length };
    const byModel = {};
    const byProvider = {};
    for (const l of rows) {
      sum.prompt += l.prompt_tokens || 0;
      sum.completion += l.completion_tokens || 0;
      sum.total += l.total_tokens || 0;
      sum.cached += l.cached_tokens || 0;
      const mk = l.target_model || '(unknown)';
      byModel[mk] = byModel[mk] || { requests: 0, prompt: 0, completion: 0, total: 0, cached: 0 };
      byModel[mk].requests += 1;
      byModel[mk].prompt += l.prompt_tokens || 0;
      byModel[mk].completion += l.completion_tokens || 0;
      byModel[mk].total += l.total_tokens || 0;
      byModel[mk].cached += l.cached_tokens || 0;
      const pk = l.provider_name || '(unknown)';
      byProvider[pk] = byProvider[pk] || { requests: 0, prompt: 0, completion: 0, total: 0, cached: 0 };
      byProvider[pk].requests += 1;
      byProvider[pk].prompt += l.prompt_tokens || 0;
      byProvider[pk].completion += l.completion_tokens || 0;
      byProvider[pk].total += l.total_tokens || 0;
      byProvider[pk].cached += l.cached_tokens || 0;
    }
    return { total: sum, by_model: byModel, by_provider: byProvider, window_days: days };
  }
};

function parseDateTime(s) {
  // "YYYY-MM-DD HH:mm:ss" -> 毫秒时间戳（本地时区）
  if (!s) return 0;
  const t = new Date(s.replace(' ', 'T')).getTime();
  return Number.isNaN(t) ? 0 : t;
}

// ============================================================
//  Model Connectivity Test Results
//  按 model_id 存储最近一次连通性测试结果
// ============================================================
const TestResultRepo = {
  all() {
    return store.test_results || {};
  },
  get(modelId) {
    return (store.test_results || {})[Number(modelId)] || null;
  },
  set(modelId, { duration_ms, ok, status, error }) {
    if (!store.test_results) store.test_results = {};
    store.test_results[Number(modelId)] = {
      model_id: Number(modelId),
      ok: ok ? 1 : 0,
      duration_ms: duration_ms || 0,
      status: status || 0,
      error: error || '',
      tested_at: now(),
    };
    persist();
  },
  remove(modelId) {
    if (store.test_results && store.test_results[Number(modelId)]) {
      delete store.test_results[Number(modelId)];
      persist();
    }
  },
};

module.exports = { ProviderRepo, ModelRepo, CustomModelRepo, LogRepo, TestResultRepo };
