require('dotenv').config();

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { MongoClient, ObjectId } = require('mongodb');

const PORT = Number(process.env.PORT || 3000);
const SECRET = process.env.APP_SECRET || 'local-development-secret-change-me';
const client = new MongoClient(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017');
const dbName = process.env.MONGODB_DB || 'questionnaire_system';
const publicDir = path.join(__dirname, 'public');
const MAX_TEMPLATE_VERSIONS = 10;

async function normalizeTemplateChains(templates, rows) {
  const chains = new Map();
  for (const row of rows) {
    const key = row.rootQuestionId?.toString();
    if (!key) continue;
    if (!chains.has(key)) chains.set(key, []);
    chains.get(key).push(row);
  }
  await Promise.all([...chains.values()].map(async (chain) => {
    const current = chain.find((item) => item.currentVersionId) || chain.reduce((latest, item) => item.version > latest.version ? item : latest, chain[0]);
    const currentId = current.currentVersionId || current._id;
    const missingNames = chain.filter((item) => !item.versionName);
    await Promise.all([
      templates.updateMany({ rootQuestionId: current.rootQuestionId, $or: [{ currentVersionId: { $exists: false } }, { currentVersionId: null }] }, { $set: { currentVersionId: currentId } }),
      ...missingNames.map((item) => templates.updateOne({ _id: item._id }, { $set: { versionName: `版本 ${item.version}` } }))
    ]);
    chain.forEach((item) => { item.currentVersionId = currentId; if (!item.versionName) item.versionName = `版本 ${item.version}`; });
  }));
}

function send(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': 'same-origin' });
  res.end(JSON.stringify(data));
}

function tokenFor(userId) {
  const payload = Buffer.from(JSON.stringify({ sub: userId, exp: Date.now() + 7 * 86400000 })).toString('base64url');
  const signature = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function userFrom(req) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;
  const expected = crypto.createHmac('sha256', SECRET).update(payload).digest();
  let actual;
  try { actual = Buffer.from(signature, 'base64url'); } catch { return null; }
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return data.exp > Date.now() ? new ObjectId(data.sub) : null;
  } catch { return null; }
}

async function bodyOf(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1_000_000) throw new Error('Request is too large');
  }
  return raw ? JSON.parse(raw) : {};
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, encoded) {
  const [scheme, salt, hash] = (encoded || '').split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

function clean(doc) {
  if (!doc) return doc;
  const { _id, ...rest } = doc;
  return { id: _id.toString(), ...rest };
}

function validateAnswer(question, value) {
  const cfg = question.validation || {};
  const empty = value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);
  if (question.required && empty) return `${question.prompt} 为必答题`;
  if (empty) return null;
  if (question.type === 'single_choice') {
    if (!question.options?.some((o) => o.key === value)) return `${question.prompt} 的选项无效`;
  } else if (question.type === 'multiple_choice') {
    if (!Array.isArray(value)) return `${question.prompt} 请使用多选答案`;
    const keys = question.options?.map((o) => o.key) || [];
    if (value.some((key) => !keys.includes(key)) || new Set(value).size !== value.length) return `${question.prompt} 包含无效选项`;
    if (cfg.minSelections !== undefined && value.length < cfg.minSelections) return `${question.prompt} 至少选择 ${cfg.minSelections} 项`;
    if (cfg.maxSelections !== undefined && value.length > cfg.maxSelections) return `${question.prompt} 最多选择 ${cfg.maxSelections} 项`;
  } else if (question.type === 'text') {
    if (typeof value !== 'string') return `${question.prompt} 必须是文本`;
    if (cfg.minLength !== undefined && [...value].length < cfg.minLength) return `${question.prompt} 至少输入 ${cfg.minLength} 字`;
    if (cfg.maxLength !== undefined && [...value].length > cfg.maxLength) return `${question.prompt} 最多输入 ${cfg.maxLength} 字`;
  } else if (question.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return `${question.prompt} 必须是数字`;
    if (cfg.integerOnly && !Number.isInteger(value)) return `${question.prompt} 必须是整数`;
    if (cfg.min !== undefined && value < cfg.min) return `${question.prompt} 不能小于 ${cfg.min}`;
    if (cfg.max !== undefined && value > cfg.max) return `${question.prompt} 不能大于 ${cfg.max}`;
  }
  return null;
}

function matches(condition, answer) {
  const value = answer?.value;
  const keys = condition.optionKeys || [];
  switch (condition.operator) {
    case 'equals': return value === keys[0];
    case 'includes_any': return Array.isArray(value) && (keys.length ? keys.some((key) => value.includes(key)) : value.length > 0);
    case 'includes_all': return Array.isArray(value) && keys.length > 0 && keys.every((key) => value.includes(key));
    case 'count_equals': return Array.isArray(value) && value.length === condition.value;
    case 'count_gte': return Array.isArray(value) && value.length >= condition.value;
    case 'count_lte': return Array.isArray(value) && value.length <= condition.value;
    case 'gt': return value > condition.value;
    case 'gte': return value >= condition.value;
    case 'lt': return value < condition.value;
    case 'lte': return value <= condition.value;
    case 'between': return value >= condition.min && value <= condition.max;
    default: return false;
  }
}

function findJumpCycle(questionCount, rules) {
  const edges = Array.from({ length: questionCount + 1 }, () => new Set());
  for (let order = 1; order <= questionCount; order += 1) {
    if (order < questionCount) edges[order].add(order + 1);
  }
  for (const rule of rules) {
    if (rule.enabled === false) continue;
    if (Number.isInteger(rule.sourceOrder) && Number.isInteger(rule.targetOrder)
      && rule.sourceOrder >= 1 && rule.sourceOrder <= questionCount
      && rule.targetOrder >= 1 && rule.targetOrder <= questionCount) {
      edges[rule.sourceOrder].add(rule.targetOrder);
    }
  }
  const state = new Array(questionCount + 1).fill(0);
  const stack = [];
  function visit(order) {
    state[order] = 1;
    stack.push(order);
    for (const target of edges[order]) {
      if (state[target] === 1) return [...stack.slice(stack.indexOf(target)), target];
      if (state[target] === 0) {
        const cycle = visit(target);
        if (cycle) return cycle;
      }
    }
    stack.pop();
    state[order] = 2;
    return null;
  }
  for (let order = 1; order <= questionCount; order += 1) {
    if (state[order] === 0) {
      const cycle = visit(order);
      if (cycle) return cycle;
    }
  }
  return null;
}

function publishCycleError(questions, rules) {
  const cycle = findJumpCycle(questions.length, rules);
  if (!cycle) return null;
  const labels = cycle.map((order) => `Q${order}${questions[order - 1]?.prompt ? ` (${questions[order - 1].prompt})` : ''}`);
  return `Cannot publish: jump rules may loop (${labels.join(' -> ')})`;
}

function templateQuestion(input) {
  const type = input?.type;
  if (!['single_choice', 'multiple_choice', 'text', 'number'].includes(type)) throw new Error('题型无效');
  const prompt = String(input.prompt || '').trim();
  if (!prompt) throw new Error('题干不能为空');
  const question = {
    type,
    prompt,
    required: Boolean(input.required),
    validation: input.validation && typeof input.validation === 'object' ? input.validation : {}
  };
  if (type === 'single_choice' || type === 'multiple_choice') {
    if (!Array.isArray(input.options) || input.options.length < 2) throw new Error('选择题至少需要两个选项');
    question.options = input.options.map((option, index) => ({ key: String(option.key || `option_${index + 1}`), text: String(option.text || '').trim(), order: index + 1 })).filter((option) => option.text);
    if (question.options.length < 2) throw new Error('选择题至少需要两个有效选项');
  }
  return question;
}

async function canUseTemplate(db, template, userId) {
  return template && (template.ownerId.equals(userId) || template.sharedWith?.some((id) => id.equals(userId)) || (template.bankId && await db.collection('question_banks').findOne({ _id: template.bankId, sharedWith: userId })));
}

async function questionsFromInput(db, input, userId, surveyId, now) {
  if (Array.isArray(input.libraryQuestionIds) && input.libraryQuestionIds.length) {
    const ids = input.libraryQuestionIds.map((id) => new ObjectId(id));
    const templates = await db.collection('question_templates').find({ _id: { $in: ids } }).toArray();
    if (templates.length !== ids.length || !(await Promise.all(templates.map((template) => canUseTemplate(db, template, userId)))).every(Boolean)) throw new Error('题库中存在无权使用的题目');
    const byId = new Map(templates.map((template) => [template._id.toString(), template]));
    return ids.map((id, index) => {
      const template = byId.get(id.toString());
      return { ...template.question, surveyId, order: index + 1, sourceTemplateId: template._id, sourceTemplateVersion: template.version, createdAt: now, updatedAt: now };
    });
  }
  if (!Array.isArray(input.questions)) return [];
  return input.questions.map((question, index) => ({
    ...question,
    ...(question.sourceTemplateId ? { sourceTemplateId: new ObjectId(question.sourceTemplateId) } : {}),
    surveyId,
    order: index + 1,
    createdAt: now,
    updatedAt: now
  }));
}

async function route(req, res) {
  const db = client.db(dbName);
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const parts = url.pathname.split('/').filter(Boolean);
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS', 'access-control-allow-headers': 'Content-Type,Authorization' }); return res.end(); }
  if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'health') return send(res, 200, { ok: true, database: dbName });

  if (req.method === 'POST' && parts[0] === 'api' && ['register', 'login'].includes(parts[1])) {
    const input = await bodyOf(req);
    const username = String(input.username || '').trim();
    const password = String(input.password || '');
    if (username.length < 3 || username.length > 64 || password.length < 8) return send(res, 400, { error: '用户名至少 3 位，密码至少 8 位' });
    const users = db.collection('users');
    let user;
    if (parts[1] === 'register') {
      user = { username, passwordHash: hashPassword(password), registeredAt: new Date() };
      try { const result = await users.insertOne(user); user._id = result.insertedId; }
      catch (error) { if (error.code === 11000) return send(res, 409, { error: '用户名已存在' }); throw error; }
    } else {
      user = await users.findOne({ username });
      if (!user || !verifyPassword(password, user.passwordHash)) return send(res, 401, { error: '用户名或密码错误' });
    }
    return send(res, 200, { token: tokenFor(user._id.toString()), user: { id: user._id.toString(), username: user.username } });
  }

  const userId = userFrom(req);
  if (!userId) return send(res, 401, { error: '请先登录' });
  const authenticatedUser = await db.collection('users').findOne({ _id: userId }, { projection: { _id: 1 } });
  if (!authenticatedUser) return send(res, 401, { error: '登录状态已失效，请重新登录' });

  if (parts[0] === 'api' && parts[1] === 'question-banks') {
    const banks = db.collection('question_banks');
    if (req.method === 'GET' && parts.length === 2) {
      const rows = await banks.find({ $or: [{ ownerId: userId }, { sharedWith: userId }] }).sort({ updatedAt: -1 }).toArray();
      return send(res, 200, rows.map(clean));
    }
    if (req.method === 'POST' && parts.length === 2) {
      const input = await bodyOf(req);
      const name = String(input.name || '').trim();
      if (!name) return send(res, 400, { error: '题库名称不能为空' });
      const nameKey = name.toLocaleLowerCase('zh-CN');
      if (await banks.findOne({ ownerId: userId, $or: [{ nameKey }, { name }] }, { projection: { _id: 1 } })) return send(res, 409, { error: '题库名称已存在，请使用其他名称' });
      const now = new Date();
      const bank = { ownerId: userId, name, nameKey, description: String(input.description || ''), visibility: input.visibility === 'shared' ? 'shared' : 'private', sharedWith: [], createdAt: now, updatedAt: now };
      try { const result = await banks.insertOne(bank); bank._id = result.insertedId; }
      catch (error) { if (error.code === 11000) return send(res, 409, { error: '题库名称已存在，请使用其他名称' }); throw error; }
      return send(res, 201, clean(bank));
    }
    if (req.method === 'POST' && parts.length === 4 && parts[3] === 'share') {
      const bank = await banks.findOne({ _id: new ObjectId(parts[2]), ownerId: userId });
      if (!bank) return send(res, 404, { error: '题库不存在' });
      const input = await bodyOf(req);
      const target = await db.collection('users').findOne({ username: String(input.username || '').trim() }, { projection: { _id: 1 } });
      if (!target) return send(res, 404, { error: '用户不存在' });
      await banks.updateOne({ _id: bank._id }, { $addToSet: { sharedWith: target._id }, $set: { visibility: 'shared', updatedAt: new Date() } });
      return send(res, 200, { shared: true });
    }
    if (req.method === 'DELETE' && parts.length === 3) {
      const bank = await banks.findOne({ _id: new ObjectId(parts[2]), ownerId: userId });
      if (!bank) return send(res, 404, { error: '题库不存在或无权删除' });
      const used = await db.collection('question_templates').countDocuments({ bankId: bank._id });
      if (used) return send(res, 409, { error: `题库仍包含 ${used} 个题目版本，请先移除题目归属` });
      await banks.deleteOne({ _id: bank._id });
      return send(res, 200, { deleted: true });
    }
  }

  if (parts[0] === 'api' && parts[1] === 'survey-templates') {
    const collection = db.collection('survey_templates');
    if (req.method === 'GET' && parts.length === 2) {
      const rows = await collection.find({ ownerId: userId }).sort({ updatedAt: -1 }).toArray();
      return send(res, 200, rows.map(clean));
    }
    if (req.method === 'POST' && parts.length === 2) {
      const input = await bodyOf(req);
      const source = await db.collection('surveys').findOne({ shortId: String(input.sourceShortId || ''), ownerId: userId, status: 'draft' });
      if (!source) return send(res, 404, { error: '只能将自己拥有的草稿保存到问卷库' });
      const [questions, rules] = await Promise.all([
        db.collection('questions').find({ surveyId: source._id }).sort({ order: 1 }).toArray(),
        db.collection('jump_rules').find({ surveyId: source._id }).toArray()
      ]);
      if (!questions.length) return send(res, 400, { error: '问卷至少需要一道题才能保存为模板' });
      const now = new Date();
      const template = {
        ownerId: userId,
        title: String(input.title || source.title).trim().slice(0, 200),
        description: source.description || '',
        allowAnonymous: source.allowAnonymous,
        allowMultipleResponses: source.allowMultipleResponses,
        questions: questions.map((question) => {
          const { _id, surveyId, createdAt, updatedAt, order, ...snapshot } = question;
          return snapshot;
        }),
        jumpRules: rules.map((rule) => ({
          sourceOrder: questions.findIndex((question) => question._id.equals(rule.sourceQuestionId)) + 1,
          targetOrder: questions.findIndex((question) => question._id.equals(rule.targetQuestionId)) + 1,
          condition: rule.condition,
          priority: rule.priority,
          enabled: rule.enabled
        })),
        createdAt: now,
        updatedAt: now
      };
      if (!template.title) return send(res, 400, { error: '问卷模板名称不能为空' });
      const result = await collection.insertOne(template);
      template._id = result.insertedId;
      return send(res, 201, clean(template));
    }
    if (req.method === 'DELETE' && parts.length === 3) {
      const result = await collection.deleteOne({ _id: new ObjectId(parts[2]), ownerId: userId });
      return result.deletedCount ? send(res, 200, { deleted: true }) : send(res, 404, { error: '问卷模板不存在或无权删除' });
    }
  }

  if (parts[0] === 'api' && parts[1] === 'question-templates') {
    const templates = db.collection('question_templates');
    if (req.method === 'GET' && parts.length === 2) {
      const sharedBanks = await db.collection('question_banks').find({ sharedWith: userId }, { projection: { _id: 1 } }).toArray();
      const rows = await templates.find({ $or: [{ ownerId: userId }, { sharedWith: userId }, { bankId: { $in: sharedBanks.map((bank) => bank._id) } }] }).sort({ rootQuestionId: 1, version: -1 }).toArray();
      await normalizeTemplateChains(templates, rows);
      const visibleBanks = await db.collection('question_banks').find({ $or: [{ ownerId: userId }, { sharedWith: userId }] }, { projection: { _id: 1, name: 1 } }).toArray();
      const bankNames = new Map(visibleBanks.map((bank) => [bank._id.toString(), bank.name]));
      return send(res, 200, rows.map((row) => ({ ...clean(row), bankName: row.bankId ? bankNames.get(row.bankId.toString()) || '已归属题库' : '未归类' })));
    }
    if (req.method === 'POST' && parts.length === 2) {
      const input = await bodyOf(req); const now = new Date();
      let question;
      try { question = templateQuestion(input.question || input); } catch (error) { return send(res, 400, { error: error.message }); }
      const rootQuestionId = new ObjectId();
      const template = { _id: new ObjectId(), ownerId: userId, rootQuestionId, version: 1, versionName: String(input.versionName || '初始版本').trim().slice(0, 100), question, ...(input.bankId ? { bankId: new ObjectId(input.bankId) } : {}), visibility: input.visibility === 'shared' ? 'shared' : 'private', sharedWith: [], status: 'active', currentVersionId: null, createdAt: now, updatedAt: now };
      template.currentVersionId = template._id;
      await templates.insertOne(template);
      return send(res, 201, clean(template));
    }
    if (req.method === 'POST' && parts.length === 4 && parts[3] === 'versions') {
      const base = await templates.findOne({ _id: new ObjectId(parts[2]) });
      if (!base || !base.ownerId.equals(userId)) return send(res, 404, { error: '题目版本不存在或无权修改' });
      const input = await bodyOf(req); let question;
      try { question = templateQuestion(input.question || input); } catch (error) { return send(res, 400, { error: error.message }); }
      const count = await templates.countDocuments({ rootQuestionId: base.rootQuestionId });
      if (count >= MAX_TEMPLATE_VERSIONS) return send(res, 409, { error: `同一题目最多保留 ${MAX_TEMPLATE_VERSIONS} 个版本，请先删除旧版本` });
      const current = base.currentVersionId ? await templates.findOne({ _id: base.currentVersionId }) : await templates.find({ rootQuestionId: base.rootQuestionId }).sort({ version: -1 }).limit(1).next();
      const maxVersion = await templates.find({ rootQuestionId: base.rootQuestionId }).sort({ version: -1 }).limit(1).next();
      const now = new Date();
      const next = { _id: new ObjectId(), ownerId: userId, rootQuestionId: base.rootQuestionId, derivedFromId: current?._id || base._id, version: (maxVersion?.version || 0) + 1, versionName: String(input.versionName || '未命名版本').trim().slice(0, 100), question, ...(input.bankId || base.bankId ? { bankId: new ObjectId(input.bankId || base.bankId) } : {}), visibility: input.visibility === 'shared' ? 'shared' : (base.visibility || 'private'), sharedWith: base.sharedWith || [], status: 'active', currentVersionId: null, createdAt: now, updatedAt: now };
      await templates.insertOne(next);
      await templates.updateMany({ rootQuestionId: base.rootQuestionId }, { $set: { currentVersionId: next._id } });
      return send(res, 201, clean(next));
    }
    if (req.method === 'POST' && parts.length === 4 && parts[3] === 'clone') {
      const base = await templates.findOne({ _id: new ObjectId(parts[2]) });
      if (!base || !base.ownerId.equals(userId)) return send(res, 404, { error: '题目版本不存在或无权复制' });
      const input = await bodyOf(req); let question;
      try { question = templateQuestion(input.question || base.question); } catch (error) { return send(res, 400, { error: error.message }); }
      const now = new Date();
      const cloned = { _id: new ObjectId(), ownerId: userId, rootQuestionId: new ObjectId(), version: 1, versionName: String(input.versionName || '初始版本').trim().slice(0, 100), derivedFromTemplateId: base._id, derivedFromVersion: base.version, question, ...(input.bankId || base.bankId ? { bankId: new ObjectId(input.bankId || base.bankId) } : {}), visibility: input.visibility === 'shared' ? 'shared' : (base.visibility || 'private'), sharedWith: [], status: 'active', currentVersionId: null, createdAt: now, updatedAt: now };
      cloned.currentVersionId = cloned._id;
      await templates.insertOne(cloned);
      return send(res, 201, clean(cloned));
    }
    if (req.method === 'GET' && parts.length === 4 && parts[3] === 'history') {
      const template = await templates.findOne({ _id: new ObjectId(parts[2]) });
      if (!await canUseTemplate(db, template, userId)) return send(res, 404, { error: '题目版本不存在或无权查看' });
      const history = await templates.find({ rootQuestionId: template.rootQuestionId }).sort({ version: 1 }).toArray();
      const versionById = new Map(history.map((item) => [item._id.toString(), item.version]));
       const currentId = template.currentVersionId || history.reduce((latest, item) => item.version > latest.version ? item : latest, history[0])?._id;
       return send(res, 200, {
        rootQuestionId: template.rootQuestionId.toString(),
         currentVersionId: currentId?.toString(),
         versions: history.map((item) => ({ ...clean(item), current: item._id.equals(currentId), derivedFromVersion: item.derivedFromId ? versionById.get(item.derivedFromId.toString()) || null : null }))
      });
    }
    if (req.method === 'POST' && parts.length === 4 && parts[3] === 'restore') {
      const source = await templates.findOne({ _id: new ObjectId(parts[2]), ownerId: userId });
      if (!source) return send(res, 404, { error: '题目版本不存在或无权恢复' });
      await templates.updateMany({ rootQuestionId: source.rootQuestionId }, { $set: { currentVersionId: source._id, updatedAt: new Date() } });
      return send(res, 200, { ...clean(source), current: true, rolledBackToVersion: source.version });
    }
    if (req.method === 'POST' && parts.length === 4 && parts[3] === 'share') {
      const template = await templates.findOne({ _id: new ObjectId(parts[2]), ownerId: userId });
      if (!template) return send(res, 404, { error: '题目版本不存在' });
      const input = await bodyOf(req); const target = await db.collection('users').findOne({ username: String(input.username || '').trim() }, { projection: { _id: 1 } });
      if (!target) return send(res, 404, { error: '用户不存在' });
      await templates.updateOne({ _id: template._id }, { $addToSet: { sharedWith: target._id }, $set: { visibility: 'shared', updatedAt: new Date() } });
      return send(res, 200, { shared: true });
    }
    if (req.method === 'DELETE' && parts.length === 3) {
      const template = await templates.findOne({ _id: new ObjectId(parts[2]), ownerId: userId });
      if (!template) return send(res, 404, { error: '题目版本不存在或无权删除' });
      const allVersions = await templates.find({ rootQuestionId: template.rootQuestionId }).toArray();
      const currentId = template.currentVersionId || allVersions.reduce((latest, item) => item.version > latest.version ? item : latest, allVersions[0])?._id;
      if (template._id.equals(currentId)) return send(res, 409, { error: '不能删除当前版本，请先回溯到其他版本' });
      const [usage] = await Promise.all([
        db.collection('questions').countDocuments({ sourceTemplateId: template._id }),
      ]);
      if (usage) return send(res, 409, { error: `该版本已被 ${usage} 个问卷快照使用，不能删除` });
      await templates.deleteOne({ _id: template._id });
      return send(res, 200, { deleted: true });
    }
    if (req.method === 'DELETE' && parts.length === 4 && parts[3] === 'chain') {
      const template = await templates.findOne({ _id: new ObjectId(parts[2]), ownerId: userId });
      if (!template) return send(res, 404, { error: '题目不存在或无权删除' });
      const chain = await templates.find({ rootQuestionId: template.rootQuestionId }, { projection: { _id: 1 } }).toArray();
      const ids = chain.map((item) => item._id);
      const usage = await db.collection('questions').countDocuments({ sourceTemplateId: { $in: ids } });
      if (usage) return send(res, 409, { error: `该题目已有 ${usage} 个问卷快照在使用，不能删除` });
      await templates.deleteMany({ _id: { $in: ids } });
      return send(res, 200, { deleted: true, deletedVersions: ids.length });
    }
    if (req.method === 'GET' && parts.length === 4 && parts[3] === 'usage') {
      const template = await templates.findOne({ _id: new ObjectId(parts[2]) });
      if (!await canUseTemplate(db, template, userId)) return send(res, 404, { error: '题目版本不存在或无权查看' });
      const version = url.searchParams.get('version');
      const chain = await templates.find({ rootQuestionId: template.rootQuestionId }, { projection: { _id: 1, version: 1 } }).toArray();
      const selected = version ? chain.find((item) => item.version === Number(version)) : null;
      if (version && !selected) return send(res, 404, { error: '题目版本不存在' });
      const sourceFilter = { sourceTemplateId: version ? selected._id : { $in: chain.map((item) => item._id) } };
      const uses = await db.collection('questions').aggregate([
        { $match: sourceFilter },
        { $lookup: { from: 'surveys', localField: 'surveyId', foreignField: '_id', as: 'survey' } },
        { $unwind: '$survey' },
        { $project: { surveyId: 1, order: 1, sourceTemplateVersion: 1, surveyTitle: '$survey.title', surveyStatus: '$survey.status', ownerId: '$survey.ownerId' } }
      ]).toArray();
      return send(res, 200, { template: clean(template), usages: uses.map(clean) });
    }
  }

  if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'question-stats' && parts[2]) {
    const template = await db.collection('question_templates').findOne({ _id: new ObjectId(parts[2]) });
    if (!await canUseTemplate(db, template, userId)) return send(res, 404, { error: '题目版本不存在或无权查看' });
    const version = url.searchParams.get('version');
    const chain = await db.collection('question_templates').find({ rootQuestionId: template.rootQuestionId }, { projection: { _id: 1, version: 1 } }).toArray();
    const selected = version ? chain.find((item) => item.version === Number(version)) : null;
    if (version && !selected) return send(res, 404, { error: '题目版本不存在' });
    const questionFilter = { sourceTemplateId: version ? selected._id : { $in: chain.map((item) => item._id) } };
    const snapshots = await db.collection('questions').find(questionFilter, { projection: { _id: 1, type: 1, prompt: 1, options: 1, sourceTemplateVersion: 1 } }).toArray();
    const ids = snapshots.map((question) => question._id);
    const answers = await db.collection('answers').aggregate([
      { $match: { questionId: { $in: ids } } },
      { $lookup: { from: 'responses', localField: 'responseId', foreignField: '_id', as: 'response' } },
      { $unwind: '$response' }, { $match: { 'response.status': 'submitted' } },
      { $project: { value: 1, questionType: 1 } }
    ]).toArray();
    const values = answers.map((answer) => answer.value);
    const numbers = values.filter((value) => typeof value === 'number');
    const counts = new Map();
    for (const value of values.flatMap((value) => Array.isArray(value) ? value : [value])) counts.set(String(value), (counts.get(String(value)) || 0) + 1);
    const canViewRaw = template.ownerId.equals(userId);
    return send(res, 200, { template: clean(template), versions: [...new Set(snapshots.map((question) => question.sourceTemplateVersion))], responseCount: answers.length, values: canViewRaw || template.question.type !== 'text' ? values : [], average: numbers.length ? numbers.reduce((sum, value) => sum + value, 0) / numbers.length : null, optionCounts: [...counts.entries()].map(([key, count]) => ({ key, count })) });
  }

  if (req.method === 'GET' && parts.join('/') === 'api/surveys') {
    const rows = await db.collection('surveys').find({ ownerId: userId }).sort({ createdAt: -1 }).toArray();
    return send(res, 200, rows.map(clean));
  }

  if (req.method === 'POST' && parts.join('/') === 'api/surveys') {
    const input = await bodyOf(req);
    if (!input.title?.trim() || (!Array.isArray(input.questions) && !Array.isArray(input.libraryQuestionIds))) return send(res, 400, { error: '问卷标题和至少一道题为必填' });
    const now = new Date();
    const survey = {
      ownerId: userId,
      shortId: crypto.randomBytes(6).toString('base64url'),
      title: input.title.trim(),
      description: input.description || '',
      allowAnonymous: Boolean(input.allowAnonymous),
      allowMultipleResponses: Boolean(input.allowMultipleResponses),
      status: input.status === 'published' ? 'published' : 'draft',
      ...(input.closesAt ? { closesAt: new Date(input.closesAt) } : {}),
      ...(input.status === 'published' ? { publishedAt: now } : {}),
      createdAt: now,
      updatedAt: now
    };
    let created;
    let questionIds = [];
    try {
      const questions = await questionsFromInput(db, input, userId, null, now);
      if (!questions.length) return send(res, 400, { error: '问卷至少需要一道题' });
      for (const rule of input.jumpRules || []) {
        if (!Number.isInteger(rule.sourceOrder) || !Number.isInteger(rule.targetOrder) || rule.sourceOrder < 1 || rule.targetOrder < 1 || rule.sourceOrder > questions.length || rule.targetOrder > questions.length) throw new Error('跳转规则题号无效');
      }
      if (input.status === 'published') {
        const cycleError = publishCycleError(questions, input.jumpRules || []);
        if (cycleError) return send(res, 400, { error: cycleError });
      }
      const inserted = await db.collection('surveys').insertOne(survey);
      survey._id = inserted.insertedId;
      questions.forEach((q) => { q.surveyId = survey._id; });
      try {
        const questionResult = await db.collection('questions').insertMany(questions);
        questionIds = Object.values(questionResult.insertedIds);
        const rules = (input.jumpRules || []).map((rule) => ({
          surveyId: survey._id,
          sourceQuestionId: questionIds[rule.sourceOrder - 1],
          targetQuestionId: questionIds[rule.targetOrder - 1],
          condition: rule.condition,
          priority: rule.priority || 1,
          enabled: rule.enabled !== false,
          createdAt: now,
          updatedAt: now
        }));
        if (rules.length) await db.collection('jump_rules').insertMany(rules);
      } catch (error) {
        if (questionIds.length) await db.collection('questions').deleteMany({ _id: { $in: questionIds } });
        await db.collection('jump_rules').deleteMany({ surveyId: survey._id });
        await db.collection('surveys').deleteOne({ _id: survey._id });
        throw error;
      }
      created = clean(survey);
    } catch (error) { throw error; }
    return send(res, 201, created);
  }

  if (parts[0] === 'api' && parts[1] === 'surveys' && parts[2]) {
    const survey = await db.collection('surveys').findOne({ shortId: parts[2], ownerId: userId });
    if (req.method === 'DELETE' && survey && parts.length === 3) {
      // A survey spans several collections. Delete dependents first so no orphaned answers remain.
      const [answers, responses, rules, questions] = await Promise.all([
        db.collection('answers').deleteMany({ surveyId: survey._id }),
        db.collection('responses').deleteMany({ surveyId: survey._id }),
        db.collection('jump_rules').deleteMany({ surveyId: survey._id }),
        db.collection('questions').deleteMany({ surveyId: survey._id })
      ]);
      await db.collection('surveys').deleteOne({ _id: survey._id, ownerId: userId });
      return send(res, 200, { deleted: true, removed: { answers: answers.deletedCount, responses: responses.deletedCount, jumpRules: rules.deletedCount, questions: questions.deletedCount } });
    }
    if (req.method === 'PUT' && survey && parts.length === 3) {
      if (survey.status !== 'draft') return send(res, 409, { error: '只能编辑草稿问卷' });
      const input = await bodyOf(req);
      if (!input.title?.trim() || (!Array.isArray(input.questions) && !Array.isArray(input.libraryQuestionIds))) return send(res, 400, { error: '问卷标题和至少一道题为必填' });
      const now = new Date();
      const questions = await questionsFromInput(db, input, userId, survey._id, now);
      if (!questions.length) return send(res, 400, { error: '问卷至少需要一道题' });
      for (const rule of input.jumpRules || []) {
        if (!Number.isInteger(rule.sourceOrder) || !Number.isInteger(rule.targetOrder) || rule.sourceOrder < 1 || rule.targetOrder < 1 || rule.sourceOrder > questions.length || rule.targetOrder > questions.length) return send(res, 400, { error: '跳转规则题号无效' });
      }
      if (input.status === 'published') {
        const cycleError = publishCycleError(questions, input.jumpRules || []);
        if (cycleError) return send(res, 400, { error: cycleError });
      }
      const previousQuestions = await db.collection('questions').find({ surveyId: survey._id }).toArray();
      const previousRules = await db.collection('jump_rules').find({ surveyId: survey._id }).toArray();
      try {
        await db.collection('jump_rules').deleteMany({ surveyId: survey._id });
        await db.collection('questions').deleteMany({ surveyId: survey._id });
        const inserted = await db.collection('questions').insertMany(questions);
        const questionIds = Object.values(inserted.insertedIds);
        const rules = (input.jumpRules || []).map((rule) => ({ surveyId: survey._id, sourceQuestionId: questionIds[rule.sourceOrder - 1], targetQuestionId: questionIds[rule.targetOrder - 1], condition: rule.condition, priority: rule.priority || 1, enabled: rule.enabled !== false, createdAt: now, updatedAt: now }));
        if (rules.length) await db.collection('jump_rules').insertMany(rules);
        const status = input.status === 'published' ? 'published' : 'draft';
        const surveyUpdate = { $set: { title: input.title.trim(), description: input.description || '', allowAnonymous: Boolean(input.allowAnonymous), allowMultipleResponses: Boolean(input.allowMultipleResponses), status, ...(input.closesAt ? { closesAt: new Date(input.closesAt) } : {}), ...(status === 'published' ? { publishedAt: now } : {}), updatedAt: now } };
        if (!input.closesAt) surveyUpdate.$unset = { closesAt: '' };
        await db.collection('surveys').updateOne({ _id: survey._id }, surveyUpdate);
      } catch (error) {
        await db.collection('jump_rules').deleteMany({ surveyId: survey._id });
        await db.collection('questions').deleteMany({ surveyId: survey._id });
        if (previousQuestions.length) await db.collection('questions').insertMany(previousQuestions);
        if (previousRules.length) await db.collection('jump_rules').insertMany(previousRules);
        throw error;
      }
      return send(res, 200, { updated: true, published: input.status === 'published' });
    }
    if (req.method === 'GET' && survey && parts[3] === 'stats') {
      const [questions, responses, answers] = await Promise.all([
        db.collection('questions').find({ surveyId: survey._id }).sort({ order: 1 }).toArray(),
        db.collection('responses').find({ surveyId: survey._id, status: 'submitted' }, { projection: { visitedQuestionIds: 1 } }).toArray(),
        db.collection('answers').aggregate([
          { $match: { surveyId: survey._id } },
          { $lookup: { from: 'responses', localField: 'responseId', foreignField: '_id', as: 'response' } },
          { $unwind: '$response' }, { $match: { 'response.status': 'submitted' } },
          { $project: { questionId: 1, questionType: 1, value: 1 } }
        ]).toArray()
      ]);
      const visitDataComplete = responses.every((response) => Array.isArray(response.visitedQuestionIds));
      const stats = questions.map((q) => {
        const values = answers.filter((a) => a.questionId.equals(q._id));
        const visitedCount = responses.filter((response) => response.visitedQuestionIds?.some((id) => id.equals(q._id))).length;
        const item = {
          question: clean(q),
          responseCount: values.length,
          visitedCount: visitDataComplete ? visitedCount : null,
          skippedCount: visitDataComplete ? responses.length - visitedCount : null,
          unansweredCount: visitDataComplete ? Math.max(0, visitedCount - values.length) : null,
          visitDataComplete
        };
        if (['single_choice', 'multiple_choice'].includes(q.type)) {
          const counts = new Map((q.options || []).map((o) => [o.key, 0]));
          for (const a of values) for (const key of (Array.isArray(a.value) ? a.value : [a.value])) counts.set(key, (counts.get(key) || 0) + 1);
          item.options = (q.options || []).map((o) => ({ key: o.key, text: o.text, count: counts.get(o.key) }));
        } else if (q.type === 'text') item.textAnswers = values.map((a) => a.value);
        else {
          const nums = values.map((a) => a.value).filter((n) => typeof n === 'number');
          item.average = nums.length ? nums.reduce((sum, n) => sum + n, 0) / nums.length : null;
        }
        return item;
      });
      return send(res, 200, { submittedCount: responses.length, visitDataComplete, questions: stats });
    }
    if (req.method === 'GET' && survey && parts[3] === 'edit') {
      const [questions, rules] = await Promise.all([
        db.collection('questions').find({ surveyId: survey._id }).sort({ order: 1 }).toArray(),
        db.collection('jump_rules').find({ surveyId: survey._id }).toArray()
      ]);
      return send(res, 200, { survey: clean(survey), questions: questions.map(clean), jumpRules: rules.map((rule) => ({ ...clean(rule), sourceOrder: questions.findIndex((q) => q._id.equals(rule.sourceQuestionId)) + 1, targetOrder: questions.findIndex((q) => q._id.equals(rule.targetQuestionId)) + 1 })) });
    }
  }

  if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'public-survey' && parts[2]) {
    const survey = await db.collection('surveys').findOne({ shortId: parts[2] });
    if (!survey || survey.status !== 'published' || (survey.closesAt && survey.closesAt <= new Date())) return send(res, 404, { error: '问卷不存在或已关闭' });
    const [questions, rules] = await Promise.all([
      db.collection('questions').find({ surveyId: survey._id }).sort({ order: 1 }).toArray(),
      db.collection('jump_rules').find({ surveyId: survey._id, enabled: true }).sort({ sourceQuestionId: 1, priority: 1 }).toArray()
    ]);
    return send(res, 200, { survey: { shortId: survey.shortId, title: survey.title, description: survey.description, allowAnonymous: survey.allowAnonymous }, questions: questions.map(clean), jumpRules: rules.map((rule) => ({ sourceOrder: questions.findIndex((q) => q._id.equals(rule.sourceQuestionId)) + 1, targetOrder: questions.findIndex((q) => q._id.equals(rule.targetQuestionId)) + 1, condition: rule.condition, priority: rule.priority })) });
  }

  if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'public-survey' && parts[2] && parts[3] === 'responses') {
    const survey = await db.collection('surveys').findOne({ shortId: parts[2], status: 'published' });
    if (!survey || (survey.closesAt && survey.closesAt <= new Date())) return send(res, 404, { error: '问卷不存在或已关闭' });
    const user = await db.collection('users').findOne({ _id: userId }, { projection: { passwordHash: 0 } });
    if (!survey.allowAnonymous && !survey.allowMultipleResponses && user && await db.collection('responses').findOne({ surveyId: survey._id, respondentId: userId, status: 'submitted' })) return send(res, 409, { error: '你已提交过这份问卷' });
    const input = await bodyOf(req);
    const questions = await db.collection('questions').find({ surveyId: survey._id }).sort({ order: 1 }).toArray();
    if (!Array.isArray(input.visitedOrders)) return send(res, 400, { error: '缺少答题访问路径' });
    const visitedOrders = input.visitedOrders;
    if (visitedOrders.some((order) => !Number.isInteger(order) || !questions.some((q) => q.order === order)) || new Set(visitedOrders).size !== visitedOrders.length) return send(res, 400, { error: '答题访问路径无效' });
    const rules = await db.collection('jump_rules').find({ surveyId: survey._id, enabled: true }).sort({ priority: 1 }).toArray();
    const questionById = new Map(questions.map((question) => [question._id.toString(), question]));
    const rulesByOrder = new Map();
    for (const rule of rules) {
      const source = questionById.get(rule.sourceQuestionId.toString());
      const target = questionById.get(rule.targetQuestionId.toString());
      if (!source || !target) continue;
      if (!rulesByOrder.has(source.order)) rulesByOrder.set(source.order, []);
      rulesByOrder.get(source.order).push({ condition: rule.condition, targetOrder: target.order, priority: rule.priority });
    }
    for (const sourceRules of rulesByOrder.values()) sourceRules.sort((left, right) => left.priority - right.priority);
    const answers = input.answers && typeof input.answers === 'object' && !Array.isArray(input.answers) ? input.answers : {};
    const expectedOrders = [];
    const visitedSet = new Set();
    let currentOrder = questions[0]?.order;
    while (currentOrder !== undefined) {
      const question = questions.find((item) => item.order === currentOrder);
      if (!question) break;
      if (visitedSet.has(currentOrder)) return send(res, 400, { error: '问卷跳转规则形成循环' });
      visitedSet.add(currentOrder);
      expectedOrders.push(currentOrder);
      const value = answers[currentOrder];
      const validationError = validateAnswer(question, value);
      if (validationError) return send(res, 400, { error: validationError });
      const matchedRule = (rulesByOrder.get(currentOrder) || []).find((rule) => matches(rule.condition, { value }));
      currentOrder = matchedRule ? matchedRule.targetOrder : currentOrder + 1;
    }
    if (expectedOrders.length !== visitedOrders.length || expectedOrders.some((order, index) => order !== visitedOrders[index])) return send(res, 400, { error: '答题路径与问卷跳转规则不一致' });
    if (Object.keys(answers).some((order) => !expectedOrders.includes(Number(order)))) return send(res, 400, { error: '答案中包含未访问题目' });
    const now = new Date();
    const response = { surveyId: survey._id, respondentId: survey.allowAnonymous ? null : userId, isAnonymous: survey.allowAnonymous, visitedQuestionIds: expectedOrders.map((order) => questions.find((q) => q.order === order)._id), status: 'submitted', startedAt: now, submittedAt: now, createdAt: now, updatedAt: now };
    const answerDocs = questions.filter((q) => {
      const value = answers[q.order];
      return expectedOrders.includes(q.order) && value !== undefined && value !== null && value !== '' && !(Array.isArray(value) && value.length === 0);
    }).map((q) => ({ responseId: null, surveyId: survey._id, questionId: q._id, questionType: q.type, value: answers[q.order], answeredAt: now, questionOrderSnapshot: q.order }));
    try {
      const result = await db.collection('responses').insertOne(response);
      response._id = result.insertedId;
      answerDocs.forEach((answer) => { answer.responseId = result.insertedId; });
      if (answerDocs.length) await db.collection('answers').insertMany(answerDocs);
    } catch (error) {
      if (response._id) await db.collection('answers').deleteMany({ responseId: response._id });
      if (response._id) await db.collection('responses').deleteOne({ _id: response._id });
      throw error;
    }
    return send(res, 201, { submitted: true });
  }

  return send(res, 404, { error: 'Not found' });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url.startsWith('/api/')) return await route(req, res);
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const requested = pathname === '/' || pathname.startsWith('/survey/') ? '/index.html' : pathname;
    const file = path.resolve(publicDir, `.${requested}`);
    if (!file.startsWith(publicDir + path.sep)) return send(res, 403, { error: 'Forbidden' });
    const content = await fs.promises.readFile(file);
    const type = file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8';
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' }); res.end(content);
  } catch (error) {
    console.error(error);
    send(res, error instanceof SyntaxError ? 400 : 500, { error: error.message || 'Internal error' });
  }
});

client.connect().then(() => {
  server.listen(PORT, () => console.log(`Online questionnaire system: http://localhost:${PORT}`));
}).catch((error) => {
  console.error('Could not connect to MongoDB:', error.message);
  process.exitCode = 1;
});
