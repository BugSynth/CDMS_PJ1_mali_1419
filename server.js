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

function send(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': 'same-origin' });
  res.end(JSON.stringify(data));
}

function tokenFor(userId) {
  const payload = Buffer.from(JSON.stringify({ sub: userId, exp: Date.now() + 7 * 86400000 })).toString('base64url');
  const signature = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function responseLimitKey(surveyId, userId) {
  return crypto.createHmac('sha256', SECRET).update(`response-limit:${surveyId}:${userId}`).digest('base64url');
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

  if (req.method === 'GET' && parts.join('/') === 'api/surveys') {
    const rows = await db.collection('surveys').find({ ownerId: userId }).sort({ createdAt: -1 }).toArray();
    return send(res, 200, rows.map(clean));
  }

  if (req.method === 'POST' && parts.join('/') === 'api/surveys') {
    const input = await bodyOf(req);
    if (!input.title?.trim() || !Array.isArray(input.questions) || input.questions.length === 0) return send(res, 400, { error: '问卷标题和至少一道题为必填' });
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
      const questions = input.questions.map((q, index) => ({ ...q, surveyId: null, order: index + 1, createdAt: now, updatedAt: now }));
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
    if (req.method === 'POST' && survey && parts[3] === 'close' && parts.length === 4) {
      if (survey.status !== 'published') return send(res, 409, { error: '只能关闭已发布问卷' });
      const now = new Date();
      await db.collection('surveys').updateOne({ _id: survey._id, ownerId: userId, status: 'published' }, { $set: { status: 'closed', closedAt: now, updatedAt: now } });
      return send(res, 200, { closed: true, closedAt: now });
    }
    if (req.method === 'PUT' && survey && parts.length === 3) {
      if (survey.status !== 'draft') return send(res, 409, { error: '只能编辑草稿问卷' });
      const input = await bodyOf(req);
      if (!input.title?.trim() || !Array.isArray(input.questions) || input.questions.length === 0) return send(res, 400, { error: '问卷标题和至少一道题为必填' });
      const now = new Date();
      const questions = input.questions.map((question, index) => ({ ...question, surveyId: survey._id, order: index + 1, createdAt: now, updatedAt: now }));
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
    const submissionKey = survey.allowMultipleResponses ? null : responseLimitKey(survey._id.toString(), userId.toString());
    if (submissionKey && await db.collection('responses').findOne({ surveyId: survey._id, submissionKey, status: 'submitted' })) return send(res, 409, { error: '你已提交过这份问卷' });
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
    const response = { surveyId: survey._id, respondentId: survey.allowAnonymous ? null : userId, ...(submissionKey ? { submissionKey } : {}), isAnonymous: survey.allowAnonymous, visitedQuestionIds: expectedOrders.map((order) => questions.find((q) => q.order === order)._id), status: 'submitted', startedAt: now, submittedAt: now, createdAt: now, updatedAt: now };
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
      if (error.code === 11000 && submissionKey) return send(res, 409, { error: '你已提交过这份问卷' });
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
