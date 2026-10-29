require('dotenv').config();

const { MongoClient, ObjectId } = require('mongodb');

const base = `http://localhost:${process.env.PORT || 3000}`;
const username = `phase2_${Date.now()}`;
const password = 'Password123';
let token;
let userId;
let sharedUserId;
let surveyShortId;
let templateSurveyShortId;
let sharedSurveyShortId;
let surveyTemplateId;
let templateId;
let bankId;
let cloneTemplateId;

async function request(path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(options.headers || {}) }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${options.method || 'GET'} ${path} -> ${response.status}: ${body.error || 'request failed'}`);
  return body;
}

async function requestAs(path, authToken, options = {}) {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${authToken}`, ...(options.headers || {}) }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${options.method || 'GET'} ${path} -> ${response.status}: ${body.error || 'request failed'}`);
  return body;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  try {
    const registered = await request('/api/register', { method: 'POST', body: JSON.stringify({ username, password }) });
  token = registered.token;
  userId = new ObjectId(registered.user.id);
  const bank = await request('/api/question-banks', { method: 'POST', body: JSON.stringify({ name: '二阶段验证题库' }) });
  bankId = bank.id;
  const duplicateResponse = await fetch(`${base}/api/question-banks`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ name: '二阶段验证题库' }) });
  assert(duplicateResponse.status === 409, '重复题库名称没有被拒绝');
  const first = await request('/api/question-templates', { method: 'POST', body: JSON.stringify({ bankId, question: { type: 'number', prompt: '验证年龄', required: true, validation: { min: 0, max: 120, integerOnly: true } } }) });
  templateId = first.id;
  const listedWithBank = await request('/api/question-templates');
  assert(listedWithBank.some((item) => item.id === templateId && item.bankName === '二阶段验证题库'), '题目列表没有返回所属题库名称');
  const second = await request(`/api/question-templates/${templateId}/versions`, { method: 'POST', body: JSON.stringify({ question: { type: 'number', prompt: '验证年龄（更新版）', required: true, validation: { min: 0, max: 130, integerOnly: true } } }) });
  assert(first.version === 1 && second.version === 2, '题目版本链不是 v1 -> v2');
  const history = await request(`/api/question-templates/${second.id}/history`);
  assert(history.versions.length === 2 && history.versions[1].derivedFromVersion === 1, '历史版本列表没有显示直接来源版本');
  const restored = await request(`/api/question-templates/${first.id}/restore`, { method: 'POST', body: '{}' });
  assert(restored.version === 1 && restored.rolledBackToVersion === 1 && restored.question.prompt === first.question.prompt, '回溯没有切换到正确的历史版本');
  const restoredHistory = await request(`/api/question-templates/${restored.id}/history`);
  assert(restoredHistory.versions.length === 2 && restoredHistory.versions.some((item) => item.current && item.version === 1), '回溯不应创建新版本或丢失当前版本指针');
  console.log('PASS 题目历史：展示直接来源，并直接回溯到 v1');
  for (let version = 3; version <= 10; version += 1) {
    await request(`/api/question-templates/${templateId}/versions`, { method: 'POST', body: JSON.stringify({ versionName: `验证版本${version}`, question: { type: 'number', prompt: `验证年龄${version}`, required: true, validation: { min: 0, max: 130, integerOnly: true } } }) });
  }
  const overLimit = await fetch(`${base}/api/question-templates/${templateId}/versions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ versionName: '超限版本', question: { type: 'number', prompt: '超限', required: true, validation: {} } }) });
  assert(overLimit.status === 409, '超过 10 个版本后仍可继续创建');
  const limitedHistory = await request(`/api/question-templates/${templateId}/history`);
  assert(limitedHistory.versions.length === 10 && limitedHistory.versions.some((item) => item.versionName === '验证版本10'), '版本上限或自定义名称未生效');
  const cloned = await request(`/api/question-templates/${templateId}/clone`, { method: 'POST', body: JSON.stringify({ versionName: '复制题目', question: first.question }) });
  cloneTemplateId = cloned.id;
  assert(cloned.version === 1 && cloned.rootQuestionId !== first.rootQuestionId, '复制为新题目没有创建独立题目');
  console.log('PASS 题目版本：最多 10 个、自定义名称、复制新题目');

  const sharedRegistered = await request('/api/register', { method: 'POST', body: JSON.stringify({ username: `${username}_shared`, password }) });
  sharedUserId = new ObjectId(sharedRegistered.user.id);
  await request(`/api/question-templates/${templateId}/share`, { method: 'POST', body: JSON.stringify({ username: `${username}_shared` }) });
  const sharedList = await requestAs('/api/question-templates', sharedRegistered.token);
  assert(sharedList.some((item) => item.id === templateId), '被共享用户无法发现题目');
  const sharedSurvey = await requestAs('/api/surveys', sharedRegistered.token, { method: 'POST', body: JSON.stringify({ title: '共享题目验证', status: 'draft', libraryQuestionIds: [templateId] }) });
  sharedSurveyShortId = sharedSurvey.shortId;
  await requestAs(`/api/surveys/${sharedSurvey.shortId}/edit`, sharedRegistered.token).then((result) => {
    assert(result.questions[0].prompt === first.question.prompt, '被共享用户无法将题目加入自己的问卷');
  });
  console.log('PASS 题目共享：接收用户可查询并复用授权题目');
  const draft = await request('/api/surveys', { method: 'POST', body: JSON.stringify({ title: '二阶段复用验证', status: 'draft', libraryQuestionIds: [templateId] }) });
  surveyShortId = draft.shortId;
  const savedSurveyTemplate = await request('/api/survey-templates', { method: 'POST', body: JSON.stringify({ sourceShortId: surveyShortId, title: '问卷库验证模板' }) });
  surveyTemplateId = savedSurveyTemplate.id;
  assert(savedSurveyTemplate.questions.length === 1 && savedSurveyTemplate.questions[0].prompt === '验证年龄', '问卷模板没有保存题目快照');
  const listedSurveyTemplates = await request('/api/survey-templates');
  assert(listedSurveyTemplates.some((item) => item.id === surveyTemplateId), '问卷模板列表未返回刚保存的模板');
  const copiedDraft = await request('/api/surveys', { method: 'POST', body: JSON.stringify({ title: '从问卷库创建的草稿', status: 'draft', questions: savedSurveyTemplate.questions, jumpRules: savedSurveyTemplate.jumpRules }) });
  templateSurveyShortId = copiedDraft.shortId;
  console.log('PASS 问卷库：模板保存、列表读取、复制及删除隔离');
  await request(`/api/surveys/${surveyShortId}`, { method: 'PUT', body: JSON.stringify({ title: draft.title, status: 'published', libraryQuestionIds: [templateId] }) });
  await request(`/api/public-survey/${surveyShortId}/responses`, { method: 'POST', body: JSON.stringify({ answers: { 1: 21 }, visitedOrders: [1] }) });
  const usage = await request(`/api/question-templates/${templateId}/usage`);
  const stats = await request(`/api/question-stats/${templateId}`);
  assert(usage.usages.length === 3, '题目使用关系数量不正确，预期原问卷、问卷库副本和共享用户问卷各一份');
  assert(stats.responseCount === 1 && stats.average === 21, '跨问卷题目统计不正确');
  const deleteUsedChain = await fetch(`${base}/api/question-templates/${templateId}/chain`, { method: 'DELETE', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` } });
  assert(deleteUsedChain.status === 409, '删除已被问卷使用的整道题目没有被拒绝');
  console.log('PASS 题库管理：重复名称拒绝、题库归属显示、已使用题目删除保护');
  await request(`/api/survey-templates/${surveyTemplateId}`, { method: 'DELETE' });
  const copiedEdit = await request(`/api/surveys/${templateSurveyShortId}/edit`);
  assert(copiedEdit.questions.length === 1 && copiedEdit.questions[0].prompt === '验证年龄', '删除问卷模板影响了已复制的问卷');
  console.log('PASS 问卷模板删除：已复制的问卷内容独立保留');
  console.log('PASS 题目版本链：v1 -> v2');
  console.log('PASS 题库复用：问卷引用具体题目版本并保持快照');
  console.log('PASS 使用关系：可查询题目所属问卷');
    console.log('PASS 跨问卷统计：提交数 1，平均值 21');
} finally {
    const client = new MongoClient(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017');
    try {
      await client.connect();
      const db = client.db(process.env.MONGODB_DB || 'questionnaire_system');
      if (surveyShortId) {
        const survey = await db.collection('surveys').findOne({ shortId: surveyShortId });
        if (survey) {
          await Promise.all([
            db.collection('answers').deleteMany({ surveyId: survey._id }),
            db.collection('responses').deleteMany({ surveyId: survey._id }),
            db.collection('jump_rules').deleteMany({ surveyId: survey._id }),
            db.collection('questions').deleteMany({ surveyId: survey._id })
          ]);
          await db.collection('surveys').deleteOne({ _id: survey._id });
        }
      }
      if (templateSurveyShortId) {
        const survey = await db.collection('surveys').findOne({ shortId: templateSurveyShortId });
        if (survey) {
          await Promise.all([
            db.collection('answers').deleteMany({ surveyId: survey._id }),
            db.collection('responses').deleteMany({ surveyId: survey._id }),
            db.collection('jump_rules').deleteMany({ surveyId: survey._id }),
            db.collection('questions').deleteMany({ surveyId: survey._id })
          ]);
          await db.collection('surveys').deleteOne({ _id: survey._id });
        }
      }
      if (sharedSurveyShortId) {
        const survey = await db.collection('surveys').findOne({ shortId: sharedSurveyShortId });
        if (survey) {
          await Promise.all([
            db.collection('answers').deleteMany({ surveyId: survey._id }),
            db.collection('responses').deleteMany({ surveyId: survey._id }),
            db.collection('jump_rules').deleteMany({ surveyId: survey._id }),
            db.collection('questions').deleteMany({ surveyId: survey._id })
          ]);
          await db.collection('surveys').deleteOne({ _id: survey._id });
        }
      }
      if (surveyTemplateId) await db.collection('survey_templates').deleteOne({ _id: new ObjectId(surveyTemplateId) });
      if (userId) {
        await db.collection('question_templates').deleteMany({ ownerId: userId });
        await db.collection('question_banks').deleteMany({ ownerId: userId });
        await db.collection('users').deleteOne({ _id: userId });
      }
      if (sharedUserId) {
        await db.collection('users').deleteOne({ _id: sharedUserId });
      }
    } finally { await client.close(); }
  }
}

main().catch((error) => { console.error(`FAIL 二阶段验证: ${error.message}`); process.exitCode = 1; });
