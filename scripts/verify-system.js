require('dotenv').config();

const crypto = require('node:crypto');
const { MongoClient, ObjectId } = require('mongodb');

const baseUrl = process.env.APP_URL || `http://127.0.0.1:${process.env.PORT || 3000}`;
const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const databaseName = process.env.MONGODB_DB || 'questionnaire_system';
const checks = [];

async function request(url, options = {}) {
  const response = await fetch(new URL(url, baseUrl), {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.token ? { authorization: `Bearer ${options.token}` } : {}), ...options.headers },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

async function check(name, action) {
  const detail = await action();
  checks.push({ name, detail });
  console.log(`PASS ${name}: ${detail}`);
}

async function main() {
  const suffix = crypto.randomBytes(6).toString('hex');
  const username = `verify_${suffix}`;
  const password = `Verify-${crypto.randomBytes(12).toString('hex')}`;
  let token;
  let shortId;
  let cycleShortId;
  let userId;
  const mongo = new MongoClient(uri);
  try {
    const registration = await request('/api/register', { method: 'POST', body: { username, password } });
    if (!registration.response.ok) throw new Error(registration.body.error || 'account creation failed');
    token = registration.body.token;
    userId = registration.body.user.id;

    const draft = {
      title: `功能验证 ${suffix}`, description: '由可复现验证流程生成，运行结束后自动清理。',
      allowAnonymous: false, allowMultipleResponses: true, status: 'draft',
      questions: [
        { type: 'number', prompt: '年龄', required: true, validation: { min: 0, max: 120, integerOnly: true } },
        { type: 'text', prompt: '未成年补充', required: true, validation: { minLength: 2, maxLength: 30 } },
        { type: 'text', prompt: '成年路径反馈', required: true, validation: { minLength: 2, maxLength: 30 } },
        { type: 'number', prompt: '评分', required: true, validation: { min: 1, max: 5, integerOnly: true } }
      ],
      jumpRules: [{ sourceOrder: 1, targetOrder: 3, priority: 1, condition: { answerType: 'number', operator: 'gte', value: 18 } }]
    };

    await check('保存草稿', async () => {
      const result = await request('/api/surveys', { method: 'POST', token, body: draft });
      if (!result.response.ok) throw new Error(result.body.error || 'draft creation failed');
      shortId = result.body.shortId;
      return '草稿已创建';
    });
    await check('读取题目与跳转规则', async () => {
      const result = await request(`/api/surveys/${shortId}/edit`, { token });
      if (!result.response.ok || result.body.questions.length !== 4 || result.body.jumpRules.length !== 1 || result.body.jumpRules[0].condition.operator !== 'gte') throw new Error('draft data mismatch');
      return '4 道题和数字阈值跳转规则已读取';
    });
    await check('发布问卷', async () => {
      const result = await request(`/api/surveys/${shortId}`, { method: 'PUT', token, body: { ...draft, status: 'published' } });
      if (!result.response.ok || !result.body.published) throw new Error(result.body.error || 'publication failed');
      return '问卷已发布';
    });
    await check('发布前拦截循环跳转', async () => {
      const cycleDraft = {
        title: `循环规则验证 ${suffix}`, description: '验证发布前循环检测并自动清理。',
        allowAnonymous: false, allowMultipleResponses: true, status: 'draft',
        questions: [
          { type: 'number', prompt: '循环数字题一', required: true, validation: { min: 0, max: 100, integerOnly: true } },
          { type: 'number', prompt: '循环数字题二', required: true, validation: { min: 0, max: 100, integerOnly: true } }
        ],
        jumpRules: [
          { sourceOrder: 1, targetOrder: 2, priority: 1, condition: { answerType: 'number', operator: 'gte', value: 1 } },
          { sourceOrder: 2, targetOrder: 1, priority: 1, condition: { answerType: 'number', operator: 'gte', value: 1 } }
        ]
      };
      const directPublished = await request('/api/surveys', { method: 'POST', token, body: { ...cycleDraft, status: 'published' } });
      if (directPublished.response.status !== 400 || !directPublished.body.error?.includes('Q1') || !directPublished.body.error?.includes('Q2')) throw new Error('direct publish cycle guard failed');
      const created = await request('/api/surveys', { method: 'POST', token, body: cycleDraft });
      if (!created.response.ok) throw new Error(created.body.error || 'cycle draft creation failed');
      cycleShortId = created.body.shortId;
      const published = await request(`/api/surveys/${cycleShortId}`, { method: 'PUT', token, body: { ...cycleDraft, status: 'published' } });
      const stored = await request(`/api/surveys/${cycleShortId}/edit`, { token });
      if (published.response.status !== 400 || !published.body.error?.includes('Q1') || !published.body.error?.includes('Q2') || stored.body.survey.status !== 'draft') throw new Error('publish cycle guard did not preserve draft');
      return `直接发布和草稿发布均返回 400 并指出循环题目；草稿仍为 ${stored.body.survey.status}`;
    });
    await check('拒绝越界答案', async () => {
      const result = await request(`/api/public-survey/${shortId}/responses`, { method: 'POST', token, body: { answers: { 1: 20, 3: '成年', 4: 9 }, visitedOrders: [1, 3, 4] } });
      if (result.response.status !== 400) throw new Error(`expected 400, received ${result.response.status}`);
      return '服务端以 400 拒绝越界数字';
    });
    await check('保存合法答卷', async () => {
      const result = await request(`/api/public-survey/${shortId}/responses`, { method: 'POST', token, body: { answers: { 1: 20, 3: '成年', 4: 5 }, visitedOrders: [1, 3, 4] } });
      if (result.response.status !== 201) throw new Error(result.body.error || `received ${result.response.status}`);
      return '答卷已提交';
    });
    await check('核对统计', async () => {
      const result = await request(`/api/surveys/${shortId}/stats`, { token });
      const skipped = result.body.questions[1];
      const reached = result.body.questions[2];
      if (!result.response.ok || result.body.submittedCount !== 1 || result.body.questions[3]?.average !== 5 || skipped?.visitedCount !== 0 || skipped?.skippedCount !== 1 || reached?.visitedCount !== 1 || !result.body.visitDataComplete) throw new Error('aggregate result mismatch');
      return '数字题触发跳转；未成年题访问 0 / 跳过 1，成年路径题访问 1，评分平均值为 5';
    });
  } finally {
    await mongo.connect();
    const db = mongo.db(databaseName);
    try {
      if (shortId && token) await request(`/api/surveys/${shortId}`, { method: 'DELETE', token });
      if (cycleShortId && token) await request(`/api/surveys/${cycleShortId}`, { method: 'DELETE', token });
      if (userId) await db.collection('users').deleteOne({ _id: new ObjectId(userId) });
      if (userId && await db.collection('surveys').countDocuments({ ownerId: new ObjectId(userId) })) throw new Error('验证问卷清理不完整');
      console.log('PASS 清理验证数据: 验证账号及问卷关联记录已删除');
    } finally {
      await mongo.close();
    }
  }
  console.log(`验证完成：${checks.length} 项通过，验证数据已清理。`);
}

main().catch((error) => {
  console.error(`验证失败: ${error.message}`);
  process.exitCode = 1;
});
