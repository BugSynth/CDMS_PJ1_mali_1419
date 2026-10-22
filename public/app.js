const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const state = { token: localStorage.getItem('questionnaireToken'), username: localStorage.getItem('questionnaireUser'), mode: 'login', questions: [], rules: [], editingShortId: null, survey: null, answers: {}, currentOrder: 1, fillerRules: [], visitHistory: [] };
const surveyRoute = location.pathname.match(/^\/survey\/([^/]+)$/);

function safe(value) { return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { 'content-type': 'application/json', ...(state.token ? { authorization: `Bearer ${state.token}` } : {}), ...options.headers } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(body.error || `请求失败 (${response.status})`); error.status = response.status; error.body = body; throw error; }
  return body;
}
function toast(message, kind = 'info') { const node = $('#toast'); node.textContent = message; node.dataset.kind = kind; node.hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => { node.hidden = true; }, 3000); }
function showView(id) { ['authPane', 'dashboard', 'filler', 'results'].forEach((name) => { const el = $(`#${name}`); el.hidden = name !== id; el.setAttribute('aria-hidden', String(name !== id)); }); }
function authMessage(message = '', success = false) { const node = $('#authMessage'); node.textContent = message; node.classList.toggle('success', success); }
function setBusy(busy) { $('#authSubmit').disabled = busy; $('#authSubmit').textContent = busy ? '处理中...' : state.mode === 'login' ? '登录' : '创建账号'; }

$$('.tab').forEach((tab) => tab.onclick = () => { state.mode = tab.dataset.mode; $$('.tab').forEach((item) => item.classList.toggle('active', item === tab)); $('#authForm').reset(); authMessage(); setBusy(false); });
$('#authForm').onsubmit = async (event) => {
  event.preventDefault(); setBusy(true); authMessage();
  try {
    const result = await api(`/api/${state.mode}`, { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) });
    state.token = result.token; state.username = result.user.username; localStorage.setItem('questionnaireToken', state.token); localStorage.setItem('questionnaireUser', state.username);
    authMessage(state.mode === 'register' ? '注册成功，正在进入工作台...' : '登录成功，正在进入工作台...', true); toast(state.mode === 'register' ? '账号已创建' : '登录成功', 'success');
    if (surveyRoute) await openSurvey(decodeURIComponent(surveyRoute[1])); else await loadDashboard();
  } catch (error) { setBusy(false); authMessage(error.message); toast(error.message, 'error'); }
};
function logout(message = '') { localStorage.clear(); state.token = null; state.username = null; $('#identity').innerHTML = ''; $('#authForm').reset(); authMessage(message); setBusy(false); showView('authPane'); if (!message) toast('已退出登录'); }
async function loadDashboard() {
  showView('dashboard'); $('#identity').innerHTML = `<span>${safe(state.username)}</span><button class="quiet" id="logout" type="button">退出</button>`; $('#logout').onclick = logout;
  try { renderSurveys(await api('/api/surveys')); } catch (error) { logout(error.message); }
}
function renderSurveys(surveys) {
  $('#surveyList').innerHTML = surveys.length ? surveys.map((survey) => {
    const shareUrl = `${location.origin}/survey/${encodeURIComponent(survey.shortId)}`;
    const publishedActions = `<div class="share-area"><code class="share-url">${safe(shareUrl)}</code><div class="share-actions"><button class="quiet" data-copy-link="${safe(shareUrl)}" type="button">复制链接</button><a class="share" href="/survey/${encodeURIComponent(survey.shortId)}" target="_blank" rel="noopener">打开链接</a></div></div>`;
    const statusLabel = survey.status === 'published' ? '已发布' : survey.status === 'closed' ? '已关闭' : '草稿';
    return `<article class="survey-row"><div><h3>${safe(survey.title)}</h3><div class="survey-meta"><span class="status ${survey.status}">${statusLabel}</span> ${new Date(survey.updatedAt).toLocaleString()}</div>${survey.status === 'published' ? publishedActions : ''}</div><div class="survey-actions">${survey.status === 'draft' ? `<button class="quiet" data-edit="${survey.shortId}" type="button">继续编辑</button><button class="primary" data-publish="${survey.shortId}" type="button">发布</button>` : ''}${survey.status === 'published' ? `<button class="quiet" data-close="${survey.shortId}" type="button">关闭</button>` : ''}<button class="quiet" data-stats="${survey.shortId}" type="button">统计</button></div></article>`;
  }).join('') : '<div class="empty">还没有问卷，创建第一份问卷开始使用。</div>';
  $$('[data-stats]').forEach((button) => button.onclick = () => showStats(button.dataset.stats));
  $$('[data-edit]').forEach((button) => button.onclick = () => editDraft(button.dataset.edit));
  $$('[data-publish]').forEach((button) => button.onclick = () => editDraft(button.dataset.publish, true));
  $$('[data-close]').forEach((button) => button.onclick = () => closeSurvey(button.dataset.close));
  $$('[data-copy-link]').forEach((button) => button.onclick = async () => {
    try { await navigator.clipboard.writeText(button.dataset.copyLink); toast('链接已复制', 'success'); }
    catch { toast('复制失败，请手动复制链接', 'error'); }
  });
}

async function closeSurvey(shortId) {
  if (!window.confirm('关闭后将不能继续填写，确定关闭此问卷吗？')) return;
  try {
    await api(`/api/surveys/${encodeURIComponent(shortId)}/close`, { method: 'POST' });
    toast('问卷已关闭', 'success');
    await loadDashboard();
  } catch (error) { toast(error.message, 'error'); }
}

function renderCaseResults(results) {
  $('#caseResults').innerHTML = `<ul>${results.map((item) => `<li class="case-${item.ok ? 'pass' : 'fail'}"><strong>${item.ok ? '通过' : '失败'}</strong><div class="case-content"><span>${safe(item.name)}</span><details><summary>查看验证证据</summary><pre>${safe(JSON.stringify(item.evidence, null, 2))}</pre></details></div></li>`).join('')}</ul>`;
}

async function verificationRequest(method, path, input) {
  const response = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${state.token}` },
    ...(input === undefined ? {} : { body: JSON.stringify(input) })
  });
  const body = await response.json().catch(() => ({}));
  return { request: { method, path, ...(input === undefined ? {} : { input }) }, response: { status: response.status, body } };
}

function assertStatus(evidence, expectedStatus) {
  evidence.assertion = { expectedStatus, actualStatus: evidence.response.status, passed: evidence.response.status === expectedStatus };
  if (!evidence.assertion.passed) throw Object.assign(new Error(evidence.response.body.error || `预期 HTTP ${expectedStatus}，实际 HTTP ${evidence.response.status}`), { evidence });
  return evidence;
}

async function checkBrowserJumpLegacy(shortId, optionKey, expectedPrompt) {
  const frame = document.createElement('iframe');
  frame.className = 'case-frame';
  frame.title = '问卷跳转功能交互验证';
  $('#caseBrowser').replaceChildren(frame);
  const loaded = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('填写页面加载超时')), 8000);
    frame.onload = () => { clearTimeout(timeout); resolve(); };
    frame.onerror = () => { clearTimeout(timeout); reject(new Error('填写页面加载失败')); };
  });
  frame.src = `/survey/${encodeURIComponent(shortId)}?verification=${Date.now()}`;
  await loaded;
  const startedAt = Date.now();
  let doc;
  while (Date.now() - startedAt < 8000) {
    doc = frame.contentDocument;
    if (doc?.querySelector('.answer-card h3') && doc.querySelector(`[name="answer"][value="${optionKey}"]`)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!doc?.querySelector('.answer-card h3')) throw new Error('填写页面没有加载出第 1 题');
  const input = doc.querySelector(`[name="answer"][value="${optionKey}"]`);
  if (!input) throw new Error(`填写页中找不到选项 ${optionKey}`);
  input.click();
  doc.querySelector('#next').click();
  const expectedOrder = optionKey === 'yes' ? 3 : 2;
  const nextStartedAt = Date.now();
  let observedPrompt = '';
  while (Date.now() - nextStartedAt < 8000) {
    observedPrompt = frame.contentDocument.querySelector('.answer-card h3')?.textContent.replace(/\s*\*\s*$/, '').trim() || '';
    if (observedPrompt) {
      const expectedStarts = expectedOrder === 3 ? '评分' : '意见';
      if (observedPrompt.startsWith(expectedStarts)) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const evidence = {
    interaction: { route: frame.src, selectedOption: optionKey, expectedOrder, expectedPrompt },
    observed: { prompt: observedPrompt },
    assertion: { expectedPrompt, actualPrompt: observedPrompt, passed: observedPrompt.startsWith(expectedPrompt) }
  };
  frame.remove();
  $('#caseBrowser').replaceChildren();
  if (!evidence.assertion.passed) throw Object.assign(new Error(`预期显示“${expectedPrompt}”，实际显示“${observedPrompt || '无题目'}”`), { evidence });
  return evidence;
}

async function checkBrowserJump(shortId, branch, unusedExpectedPrompt) {
  const frame = document.createElement('iframe');
  frame.className = 'case-frame';
  $('#caseBrowser').replaceChildren(frame);
  const loaded = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Filling page load timed out')), 8000);
    frame.onload = () => { clearTimeout(timeout); resolve(); };
    frame.onerror = () => { clearTimeout(timeout); reject(new Error('Filling page failed to load')); };
  });
  frame.src = `/survey/${encodeURIComponent(shortId)}?verification=${Date.now()}`;
  await loaded;
  const input = frame.contentDocument?.querySelector('[name="answer"]');
  if (!input || !frame.contentDocument.querySelector('.answer-card h2')) throw new Error('Question 1 input was not rendered');
  const value = branch === 'yes' ? 20 : 17;
  const expectedPrompt = branch === 'yes' ? 'Reached path' : 'Skipped path';
  input.value = String(value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  frame.contentDocument.querySelector('#next').click();
  const startedAt = Date.now();
  let observedPrompt = '';
  while (Date.now() - startedAt < 8000) {
    observedPrompt = frame.contentDocument.querySelector('.answer-card h2')?.textContent.replace(/\s*\*\s*$/, '').trim() || '';
    if (observedPrompt.startsWith(expectedPrompt)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const evidence = { input: { question: 'Age threshold', value }, expectedPrompt, observedPrompt, passed: observedPrompt.startsWith(expectedPrompt) };
  frame.remove();
  $('#caseBrowser').replaceChildren();
  if (!evidence.passed) throw Object.assign(new Error(`Expected ${expectedPrompt}, observed ${observedPrompt || 'no question'}`), { evidence });
  return evidence;
}

$('#casesToggle').onclick = () => { $('#casePanel').hidden = !$('#casePanel').hidden; };
$('#runCases').onclick = async () => {
  const button = $('#runCases');
  const results = [];
  let shortId;
  const record = async (name, action) => {
    try { const evidence = await action(); results.push({ name, ok: true, evidence }); }
    catch (error) { results.push({ name, ok: false, evidence: error.evidence || { error: error.message, status: error.status, response: error.body } }); throw error; }
    finally { renderCaseResults(results); }
  };
  button.disabled = true;
  button.textContent = '验证中...';
  $('#caseResults').innerHTML = '<p class="muted">正在执行核心流程验证...</p>';
  try {
    const marker = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(-12);
    const draft = {
      title: `功能验证问卷 ${marker}`, description: '此问卷由工作台功能验证创建，并会自动清理。', allowAnonymous: false, allowMultipleResponses: true, status: 'draft',
      questions: [
        { type: 'single_choice', prompt: '是否继续？', required: true, options: [{ key: 'yes', text: '继续', order: 1 }, { key: 'no', text: '结束', order: 2 }], validation: {} },
        { type: 'text', prompt: '意见', required: true, validation: { minLength: 2, maxLength: 30 } },
        { type: 'number', prompt: '评分', required: true, validation: { min: 1, max: 5, integerOnly: true } }
      ],
      jumpRules: [{ sourceOrder: 1, targetOrder: 3, priority: 1, condition: { answerType: 'single_choice', operator: 'equals', optionKeys: ['yes'] } }]
    };
    draft.questions = [
      { type: 'number', prompt: 'Age threshold', required: true, validation: { min: 0, max: 120, integerOnly: true } },
      { type: 'text', prompt: 'Skipped path', required: true, validation: { minLength: 2, maxLength: 30 } },
      { type: 'text', prompt: 'Reached path', required: true, validation: { minLength: 2, maxLength: 30 } },
      { type: 'number', prompt: '评分', required: true, validation: { min: 1, max: 5, integerOnly: true } }
    ];
    draft.jumpRules = [{ sourceOrder: 1, targetOrder: 3, priority: 1, condition: { answerType: 'number', operator: 'gte', value: 18 } }];
    await record('保存草稿', async () => {
      const evidence = assertStatus(await verificationRequest('POST', '/api/surveys', draft), 201);
      shortId = evidence.response.body.shortId;
      evidence.assertion.expected = '返回问卷 shortId';
      evidence.assertion.actual = shortId;
      evidence.assertion.passed = Boolean(shortId);
      if (!shortId) throw Object.assign(new Error('响应中缺少 shortId'), { evidence });
      return evidence;
    });
    await record('读取题目和跳转规则', async () => {
      const evidence = await verificationRequest('GET', `/api/surveys/${encodeURIComponent(shortId)}/edit`);
      const data = evidence.response.body;
      evidence.assertion = { expected: { questionCount: 4, ruleCount: 1, operator: 'gte' }, actual: { questionCount: data.questions?.length, ruleCount: data.jumpRules?.length, operator: data.jumpRules?.[0]?.condition?.operator }, passed: data.questions?.length === 4 && data.jumpRules?.length === 1 && data.jumpRules?.[0]?.condition?.operator === 'gte' };
      if (!evidence.assertion.passed) throw Object.assign(new Error('草稿题目或跳转规则数量不符'), { evidence });
      evidence.response.body = { surveyStatus: data.survey.status, questions: data.questions.map(({ order, type, prompt }) => ({ order, type, prompt })), jumpRules: data.jumpRules.map(({ sourceOrder, targetOrder, condition }) => ({ sourceOrder, targetOrder, condition })) };
      return evidence;
    });
    await record('发布问卷', async () => {
      const evidence = assertStatus(await verificationRequest('PUT', `/api/surveys/${encodeURIComponent(shortId)}`, { ...draft, status: 'published' }), 200);
      evidence.assertion.expectedPublished = true;
      evidence.assertion.actualPublished = evidence.response.body.published;
      evidence.assertion.passed = evidence.assertion.passed && evidence.response.body.published === true;
      if (!evidence.assertion.passed) throw Object.assign(new Error('发布响应未确认 published 状态'), { evidence });
      return evidence;
    });
    await record('实际填写页跳转', async () => ({
      question1Yes: await checkBrowserJump(shortId, 'yes', '评分'),
      question1No: await checkBrowserJump(shortId, 'no', '意见')
    }));
    await record('拒绝非法数字答案', async () => {
      const evidence = await verificationRequest('POST', `/api/public-survey/${encodeURIComponent(shortId)}/responses`, { answers: { 1: 20, 3: 'adult', 4: 9 }, visitedOrders: [1, 3, 4] });
      evidence.assertion = { expectedStatus: 400, actualStatus: evidence.response.status, expectedErrorContains: '评分', actualError: evidence.response.body.error, passed: evidence.response.status === 400 && evidence.response.body.error?.includes('评分') };
      if (!evidence.assertion.passed) throw Object.assign(new Error('越界数字没有返回预期的服务端校验错误'), { evidence });
      return evidence;
    });
    await record('提交合法答卷', async () => {
      const evidence = assertStatus(await verificationRequest('POST', `/api/public-survey/${encodeURIComponent(shortId)}/responses`, { answers: { 1: 20, 3: 'adult', 4: 5 }, visitedOrders: [1, 3, 4] }), 201);
      evidence.assertion.expected = { submitted: true };
      evidence.assertion.actual = evidence.response.body;
      evidence.assertion.passed = evidence.assertion.passed && evidence.response.body.submitted === true;
      if (!evidence.assertion.passed) throw Object.assign(new Error('提交响应未确认保存成功'), { evidence });
      return evidence;
    });
    await record('核对统计结果', async () => {
      const evidence = await verificationRequest('GET', `/api/surveys/${encodeURIComponent(shortId)}/stats`);
      const data = evidence.response.body;
      evidence.assertion = { expected: { submittedCount: 1, scoreAverage: 5, skippedVisits: 0, skippedCount: 1, reachedVisits: 1 }, actual: { submittedCount: data.submittedCount, scoreAverage: data.questions?.[3]?.average, skippedVisits: data.questions?.[1]?.visitedCount, skippedCount: data.questions?.[1]?.skippedCount, reachedVisits: data.questions?.[2]?.visitedCount }, passed: data.submittedCount === 1 && data.questions?.[3]?.average === 5 && data.questions?.[1]?.visitedCount === 0 && data.questions?.[1]?.skippedCount === 1 && data.questions?.[2]?.visitedCount === 1 && data.visitDataComplete === true };
      if (!evidence.assertion.passed) throw Object.assign(new Error('统计结果与已提交答案不符'), { evidence });
      evidence.response.body = { submittedCount: data.submittedCount, visitDataComplete: data.visitDataComplete, questions: data.questions.map((item) => ({ order: item.question.order, prompt: item.question.prompt, responseCount: item.responseCount, visitedCount: item.visitedCount, skippedCount: item.skippedCount, unansweredCount: item.unansweredCount, average: item.average, options: item.options })) };
      return evidence;
    });
  } catch (_) {
    // Individual failed steps are already shown in the panel.
  } finally {
    if (shortId) {
      try {
        const evidence = assertStatus(await verificationRequest('DELETE', `/api/surveys/${encodeURIComponent(shortId)}`), 200);
        const expectedRemoval = { answers: 3, responses: 1, jumpRules: 1, questions: 4 };
        const removed = evidence.response.body.removed || {};
        evidence.assertion = { expected: { deleted: true, removed: expectedRemoval }, actual: { deleted: evidence.response.body.deleted, removed }, passed: evidence.response.body.deleted === true && Object.entries(expectedRemoval).every(([key, count]) => removed[key] === count) };
        if (!evidence.assertion.passed) throw Object.assign(new Error('级联删除数量与验证数据不符'), { evidence });
        results.push({ name: '清理验证数据', ok: true, evidence });
      } catch (error) { results.push({ name: '清理验证数据', ok: false, evidence: error.evidence || { error: error.message, status: error.status, response: error.body } }); }
      renderCaseResults(results);
    }
    $('#caseBrowser').replaceChildren();
    button.disabled = false;
    button.textContent = '运行验证';
    await loadDashboard();
  }
};

function newQuestion(type) {
  if (type === 'fill') return { type: 'text', fillKind: 'text', prompt: '', required: false, validation: { minLength: 0, maxLength: 500 } };
  return { type, prompt: '', required: false, options: [{ key: 'option_1', text: '选项一', order: 1 }, { key: 'option_2', text: '选项二', order: 2 }], validation: type === 'multiple_choice' ? { minSelections: 0, maxSelections: 2 } : {} };
}
function isChoice(question) { return question.type === 'single_choice' || question.type === 'multiple_choice'; }
function questionKind(question) { return isChoice(question) ? question.type : 'fill'; }
function normalizeRuleState() { state.rules = state.rules.filter((rule) => rule.sourceOrder <= state.questions.length && rule.targetOrder <= state.questions.length); }

function openBuilder() { $('#builder').hidden = false; $('#builder').scrollIntoView({ behavior: 'smooth', block: 'start' }); }
$('#createToggle').onclick = () => { state.editingShortId = null; state.questions = []; state.rules = []; $('#surveyForm').reset(); $('#builder .section-head h2').textContent = '问卷设置'; renderQuestions(); renderRules(); openBuilder(); };
$('#builderClose').onclick = () => { $('#builder').hidden = true; state.editingShortId = null; };
$$('[data-add]').forEach((button) => button.onclick = () => { state.questions.push(newQuestion(button.dataset.add)); renderQuestions(); renderRules(); });

function renderQuestions() {
  $('#questionCount').textContent = state.questions.length;
  $('#questionList').innerHTML = state.questions.map((question, index) => {
    const kind = questionKind(question);
    const fillConfig = question.type === 'text'
      ? `<label>填空类型<select data-fill-kind><option value="text" selected>文本</option><option value="number">数字</option></select></label><label>最少字符<input data-min type="number" min="0" value="${question.validation.minLength ?? 0}"></label><label>最多字符<input data-max type="number" min="0" value="${question.validation.maxLength ?? 500}"></label>`
      : `<label>填空类型<select data-fill-kind><option value="text">文本</option><option value="number" selected>数字</option></select></label><label>最小值<input data-min type="number" value="${question.validation.min ?? ''}"></label><label>最大值<input data-max type="number" value="${question.validation.max ?? ''}"></label><label>只能整数<select data-int><option value="false">否</option><option value="true" ${question.validation.integerOnly ? 'selected' : ''}>是</option></select></label>`;
    return `<article class="question-card" data-index="${index}"><div class="question-top"><label>第 ${index + 1} 题<input data-prompt value="${safe(question.prompt)}" placeholder="输入题目"></label><label>题型<select data-kind><option value="single_choice" ${kind === 'single_choice' ? 'selected' : ''}>单选</option><option value="multiple_choice" ${kind === 'multiple_choice' ? 'selected' : ''}>多选</option><option value="fill" ${kind === 'fill' ? 'selected' : ''}>填空</option></select></label><button type="button" class="danger remove">删除</button></div><label class="check-row"><input data-required type="checkbox" ${question.required ? 'checked' : ''}> 必答</label>${isChoice(question) ? `<label class="options-label">选项（每行一个）<textarea data-options rows="3">${question.options.map((option) => option.text).join('\n')}</textarea></label>` : ''}<div class="config-grid">${question.type === 'multiple_choice' ? `<label>最少选择<input data-min type="number" min="0" value="${question.validation.minSelections ?? 0}"></label><label>最多选择<input data-max type="number" min="0" value="${question.validation.maxSelections ?? 2}"></label>` : questionKind(question) === 'fill' ? fillConfig : ''}</div></article>`;
  }).join('');
  $$('.question-card').forEach((card) => {
    const index = Number(card.dataset.index); const question = state.questions[index];
    $('[data-prompt]', card).oninput = (event) => { question.prompt = event.target.value; renderRules(); };
    $('[data-kind]', card).onchange = (event) => { state.questions[index] = { ...newQuestion(event.target.value), prompt: question.prompt, required: question.required }; renderQuestions(); normalizeRuleState(); renderRules(); };
    $('[data-required]', card).onchange = (event) => { question.required = event.target.checked; };
    const options = $('[data-options]', card); if (options) options.oninput = (event) => { question.options = event.target.value.split('\n').map((text, position) => ({ key: `option_${position + 1}`, text: text.trim(), order: position + 1 })).filter((option) => option.text); renderRules(); };
    const fillKind = $('[data-fill-kind]', card); if (fillKind) fillKind.onchange = (event) => { const next = newQuestion('fill'); next.type = event.target.value; next.fillKind = event.target.value; next.validation = next.type === 'text' ? { minLength: 0, maxLength: 500 } : { integerOnly: false }; next.prompt = question.prompt; next.required = question.required; state.questions[index] = next; renderQuestions(); renderRules(); };
    const min = $('[data-min]', card); if (min) min.onchange = (event) => { const key = question.type === 'multiple_choice' ? 'minSelections' : question.type === 'text' ? 'minLength' : 'min'; question.validation[key] = event.target.value === '' ? undefined : Number(event.target.value); };
    const max = $('[data-max]', card); if (max) max.onchange = (event) => { const key = question.type === 'multiple_choice' ? 'maxSelections' : question.type === 'text' ? 'maxLength' : 'max'; question.validation[key] = event.target.value === '' ? undefined : Number(event.target.value); };
    const integerOnly = $('[data-int]', card); if (integerOnly) integerOnly.onchange = (event) => { question.validation.integerOnly = event.target.value === 'true'; };
    $('.remove', card).onclick = () => {
      const removedOrder = index + 1;
      state.questions.splice(index, 1);
      state.rules = state.rules
        .filter((rule) => rule.sourceOrder !== removedOrder && rule.targetOrder !== removedOrder)
        .map((rule) => ({ ...rule, sourceOrder: rule.sourceOrder > removedOrder ? rule.sourceOrder - 1 : rule.sourceOrder, targetOrder: rule.targetOrder > removedOrder ? rule.targetOrder - 1 : rule.targetOrder }));
      renderQuestions();
      renderRules();
    };
  });
}

function ruleOperators(question) {
  if (question?.type === 'single_choice') return [['equals', '等于选项']];
  if (question?.type === 'multiple_choice') return [['includes_any', '包含任一选项'], ['includes_all', '包含全部选项'], ['count_equals', '选择数量等于'], ['count_gte', '选择数量不少于'], ['count_lte', '选择数量不多于']];
  if (question?.type === 'number') return [['gt', '大于'], ['gte', '大于等于'], ['lt', '小于'], ['lte', '小于等于'], ['between', '介于范围内']];
  return [];
}
function ruleOperand(rule, source) {
  if (rule.operator === 'equals' || rule.operator === 'includes_all') return `<label>匹配选项<select data-options multiple>${(source?.options || []).map((option) => `<option value="${option.key}" ${rule.optionKeys.includes(option.key) ? 'selected' : ''}>${safe(option.text)}</option>`).join('')}</select></label>`;
  if (rule.operator === 'includes_any') return '';
  if (rule.operator === 'between') return `<label>最小值<input data-min-value type="number" value="${rule.min ?? ''}"></label><label>最大值<input data-max-value type="number" value="${rule.max ?? ''}"></label>`;
  return `<label>匹配数值<input data-number-value type="number" value="${rule.value ?? ''}"></label>`;
}
function defaultRule() { const source = state.questions.find((question) => question.type !== 'text'); const sourceOrder = source ? state.questions.indexOf(source) + 1 : 1; const operator = ruleOperators(source)[0]?.[0] || 'equals'; return { sourceOrder, targetOrder: Math.min(state.questions.length, sourceOrder + 1), operator, optionKeys: source?.options?.[0] ? [source.options[0].key] : [], value: 0, min: 0, max: 1, priority: state.rules.length + 1 }; }
$('#addRule').onclick = () => { if (state.questions.length < 2) return toast('至少添加两道题后才能设置跳转规则', 'error'); if (!state.questions.some((question) => question.type !== 'text')) return toast('跳转来源需要单选、多选或数字填空题', 'error'); state.rules.push(defaultRule()); renderRules(); };
function renderRules() {
  const questionOptions = state.questions.map((question, index) => `<option value="${index + 1}">第 ${index + 1} 题 ${safe(question.prompt || questionKind(question))}</option>`).join('');
  const sourceOptions = state.questions.map((question, index) => question.type === 'text' ? '' : `<option value="${index + 1}">第 ${index + 1} 题 ${safe(question.prompt || questionKind(question))}</option>`).join('');
  $('#ruleList').innerHTML = state.rules.map((rule, index) => {
    const source = state.questions[rule.sourceOrder - 1]; const operators = ruleOperators(source); if (!operators.some(([key]) => key === rule.operator)) rule.operator = operators[0]?.[0] || 'equals';
    const operand = ruleOperand(rule, source);
    return `<article class="rule-card" data-rule="${index}"><label>来源题<select data-source>${sourceOptions}</select></label><label>条件<select data-operator>${operators.map(([key, text]) => `<option value="${key}" ${rule.operator === key ? 'selected' : ''}>${text}</option>`).join('')}</select></label><div class="rule-operands">${operand}</div><label>跳至<select data-target>${questionOptions}</select></label><label>优先级<input data-priority type="number" min="1" value="${rule.priority}"></label><button type="button" class="danger remove-rule">删除</button></article>`;
  }).join('') || '<span class="rule-hint">暂无规则。未命中规则时按题目顺序继续。</span>';
  $$('.rule-card').forEach((card) => {
    const rule = state.rules[Number(card.dataset.rule)];
    $('[data-source]', card).value = rule.sourceOrder; $('[data-target]', card).value = rule.targetOrder;
    $('[data-source]', card).onchange = (event) => { rule.sourceOrder = Number(event.target.value); const q = state.questions[rule.sourceOrder - 1]; rule.operator = ruleOperators(q)[0]?.[0] || 'equals'; rule.optionKeys = q.options?.[0] ? [q.options[0].key] : []; renderRules(); };
    $('[data-operator]', card).onchange = (event) => { rule.operator = event.target.value; if (rule.operator === 'includes_any') rule.optionKeys = []; renderRules(); };
    $('[data-target]', card).onchange = (event) => { rule.targetOrder = Number(event.target.value); };
    const optionSelect = $('[data-options]', card); if (optionSelect) optionSelect.onchange = () => { rule.optionKeys = [...optionSelect.selectedOptions].map((option) => option.value); };
    const number = $('[data-number-value]', card); if (number) number.onchange = (event) => { rule.value = Number(event.target.value); };
    const min = $('[data-min-value]', card); if (min) min.onchange = (event) => { rule.min = Number(event.target.value); };
    const max = $('[data-max-value]', card); if (max) max.onchange = (event) => { rule.max = Number(event.target.value); };
    $('[data-priority]', card).onchange = (event) => { rule.priority = Math.max(1, Number(event.target.value) || 1); };
    $('.remove-rule', card).onclick = () => { state.rules.splice(Number(card.dataset.rule), 1); renderRules(); };
  });
}

$('#surveyForm').onsubmit = async (event) => {
  event.preventDefault(); const form = new FormData(event.currentTarget); const status = event.submitter.value;
  if (!state.questions.length || state.questions.some((question) => !question.prompt.trim())) return toast('请至少添加一道已填写题目的问题', 'error');
  if (state.questions.some((question) => isChoice(question) && question.options.length < 2)) return toast('选择题至少需要两个选项', 'error');
  if (state.rules.some((rule) => rule.sourceOrder === rule.targetOrder)) return toast('跳转目标不能是来源题本身', 'error');
  if (state.rules.some((rule) => ['equals', 'includes_all'].includes(rule.operator) && !rule.optionKeys.length)) return toast('“等于选项”和“包含全部选项”至少选择一个选项', 'error');
  if (state.rules.some((rule) => rule.operator === 'between' && (!Number.isFinite(rule.min) || !Number.isFinite(rule.max) || rule.min > rule.max))) return toast('数字区间无效，请检查最小值和最大值', 'error');
  if (state.rules.some((rule) => ['count_equals', 'count_gte', 'count_lte', 'gt', 'gte', 'lt', 'lte'].includes(rule.operator) && !Number.isFinite(rule.value))) return toast('跳转规则的匹配数值无效', 'error');
  const questions = state.questions.map((question) => ({ ...question, validation: Object.fromEntries(Object.entries(question.validation).filter(([, value]) => value !== undefined)) }));
  const jumpRules = state.rules.map((rule) => ({ sourceOrder: rule.sourceOrder, targetOrder: rule.targetOrder, priority: rule.priority, condition: { answerType: questions[rule.sourceOrder - 1].type, operator: rule.operator, ...(rule.operator === 'equals' || rule.operator === 'includes_all' ? { optionKeys: rule.optionKeys } : rule.operator === 'between' ? { min: rule.min, max: rule.max } : ['count_equals', 'count_gte', 'count_lte'].includes(rule.operator) ? { value: rule.value } : rule.operator === 'includes_any' ? {} : { value: rule.value }) } }));
  const payload = { title: form.get('title'), description: form.get('description'), allowAnonymous: form.has('allowAnonymous'), allowMultipleResponses: form.has('allowMultipleResponses'), closesAt: form.get('closesAt') || undefined, status, questions, jumpRules };
  try { await api(state.editingShortId ? `/api/surveys/${encodeURIComponent(state.editingShortId)}` : '/api/surveys', { method: state.editingShortId ? 'PUT' : 'POST', body: JSON.stringify(payload) }); $('#builder').hidden = true; state.editingShortId = null; toast(status === 'published' ? '问卷已发布' : '草稿已保存', 'success'); await loadDashboard(); } catch (error) { toast(error.message, 'error'); }
};

async function editDraft(shortId, publishNow = false) {
  try {
    const data = await api(`/api/surveys/${encodeURIComponent(shortId)}/edit`);
    if (data.survey.status !== 'draft') return toast('只能编辑草稿问卷', 'error');
    state.editingShortId = shortId;
    state.questions = data.questions.map(({ id, surveyId, order, createdAt, updatedAt, ...question }) => ({ ...question, fillKind: question.type === 'number' ? 'number' : question.type === 'text' ? 'text' : undefined }));
    state.rules = data.jumpRules.map((rule) => ({ sourceOrder: rule.sourceOrder, targetOrder: rule.targetOrder, operator: rule.condition.operator, optionKeys: rule.condition.optionKeys || [], value: rule.condition.value, min: rule.condition.min, max: rule.condition.max, priority: rule.priority }));
    const form = $('#surveyForm'); form.elements.title.value = data.survey.title; form.elements.description.value = data.survey.description || ''; form.elements.allowAnonymous.checked = data.survey.allowAnonymous; form.elements.allowMultipleResponses.checked = data.survey.allowMultipleResponses;
    form.elements.closesAt.value = data.survey.closesAt ? new Date(data.survey.closesAt).toISOString().slice(0, 16) : '';
    $('#builder .section-head h2').textContent = publishNow ? '发布草稿' : '编辑草稿';
    renderQuestions(); renderRules(); openBuilder();
    if (publishNow) toast('请检查草稿内容，然后点击“发布问卷”', 'info');
  } catch (error) { toast(error.message, 'error'); }
}

async function showStats(shortId) { try { const data = await api(`/api/surveys/${shortId}/stats`); const visitSummary = data.visitDataComplete ? '访问数据完整' : '历史答卷缺少访问路径，访问/跳过指标不显示'; showView('results'); $('#results').innerHTML = `<div class="result-head"><h1>问卷统计</h1><button class="quiet" id="backResults" type="button">返回</button></div><p>已提交 ${data.submittedCount} 份 · ${visitSummary}</p>${data.questions.map((item) => { const pathMetrics = item.visitDataComplete ? `<p class="muted">已回答 ${item.responseCount} · 已访问 ${item.visitedCount} · 被跳过 ${item.skippedCount} · 访问后未答 ${item.unansweredCount}</p>` : `<p class="muted">已回答 ${item.responseCount}</p>`; const values = item.options ? item.options.map((option) => `<p>${safe(option.text)}：${option.count}</p>`).join('') : item.textAnswers ? item.textAnswers.map((value) => `<p>${safe(value)}</p>`).join('') : `<p>平均值：${item.average ?? '暂无数据'}</p>`; return `<article class="result-question"><h3>${item.question.order}. ${safe(item.question.prompt)}</h3>${pathMetrics}${values}</article>`; }).join('')}`; $('#backResults').onclick = loadDashboard; } catch (error) { toast(error.message, 'error'); } }
function answerInput(question) { if (isChoice(question)) return `<div class="answer-options">${question.options.map((option) => `<label class="answer-option"><input type="${question.type === 'single_choice' ? 'radio' : 'checkbox'}" name="answer" value="${safe(option.key)}"><span>${safe(option.text)}</span></label>`).join('')}</div>`; return `<div class="answer-field"><input name="answer" type="${question.type === 'number' ? 'number' : 'text'}" ${question.validation?.integerOnly ? 'step="1"' : ''} ${question.required ? 'aria-required="true"' : ''}></div>`; }
async function openSurvey(shortId) { if (!state.token) { showView('authPane'); authMessage('请先登录后填写问卷。'); return; } try { const data = await api(`/api/public-survey/${shortId}`); state.survey = data.survey; state.questions = data.questions; state.fillerRules = data.jumpRules; state.answers = {}; state.currentOrder = data.questions[0]?.order || 1; state.visitHistory = state.currentOrder ? [state.currentOrder] : []; renderFill(); } catch (error) { showView('filler'); $('#filler').innerHTML = `<div class="empty">${safe(error.message)}</div>`; } }
function conditionMatches(condition, value) { if (condition.operator === 'equals') return value === condition.optionKeys?.[0]; if (condition.operator === 'includes_any') return Array.isArray(value) && (condition.optionKeys?.length ? condition.optionKeys.some((key) => value.includes(key)) : value.length > 0); if (condition.operator === 'includes_all') return Array.isArray(value) && condition.optionKeys.length > 0 && condition.optionKeys.every((key) => value.includes(key)); if (condition.operator === 'count_equals') return Array.isArray(value) && value.length === condition.value; if (condition.operator === 'count_gte') return Array.isArray(value) && value.length >= condition.value; if (condition.operator === 'count_lte') return Array.isArray(value) && value.length <= condition.value; if (condition.operator === 'between') return value >= condition.min && value <= condition.max; return condition.operator === 'gt' ? value > condition.value : condition.operator === 'gte' ? value >= condition.value : condition.operator === 'lt' ? value < condition.value : value <= condition.value; }
function renderFill() {
  const question = state.questions.find((item) => item.order === state.currentOrder);
  if (!question) return submitFill();
  showView('filler');
  const saved = state.answers[question.order];
  $('#filler').innerHTML = `<section class="filler-shell"><header class="filler-head"><div><span class="eyebrow">${safe(state.survey.title)}</span><h1>填写问卷</h1></div><p>第 ${question.order} 题 / 共 ${state.questions.length} 题</p></header><div class="filler-progress"><i style="width:${Math.min(100, question.order / state.questions.length * 100)}%"></i></div><article class="answer-card"><div class="answer-prompt"><span class="question-index">${question.order}</span><div><h2 tabindex="-1">${safe(question.prompt)}${question.required ? '<em aria-label="必答">*</em>' : ''}</h2><p>${question.type === 'multiple_choice' ? '可多选' : question.type === 'single_choice' ? '请选择一项' : question.type === 'number' ? '请输入数字' : '请输入回答'}${question.required ? ' · 必答' : ' · 选答'}</p></div></div>${answerInput(question)}</article><footer class="filler-footer"><button class="quiet" id="previous" type="button" ${state.visitHistory.length ? '' : 'disabled'}>上一题</button><button class="primary" id="next" type="button">${question.order === state.questions.length ? '提交问卷' : '继续'}</button></footer></section>`;
  $('#filler .answer-prompt h2').focus({ preventScroll: true });
  const inputs = $$('[name=answer]');
  if (saved !== undefined) inputs.forEach((input) => { input.checked = Array.isArray(saved) ? saved.includes(input.value) : input.value === String(saved); if (!['radio', 'checkbox'].includes(input.type)) input.value = saved; });
  $('#previous').onclick = () => { if (state.visitHistory.length > 1) state.visitHistory.pop(); state.currentOrder = state.visitHistory.at(-1); renderFill(); };
  $('#next').onclick = () => {
    let value = question.type === 'single_choice' ? inputs.find((input) => input.checked)?.value : question.type === 'multiple_choice' ? inputs.filter((input) => input.checked).map((input) => input.value) : inputs[0].value;
    if (question.type === 'number' && value !== '') value = Number(value);
    const empty = value === undefined || value === '' || (Array.isArray(value) && !value.length);
    const v = question.validation || {};
    if (question.required && empty) return toast('此题为必答题', 'error');
    if (question.type === 'multiple_choice' && !empty && (value.length < (v.minSelections ?? 0) || value.length > (v.maxSelections ?? Infinity))) return toast('多选数量不符合限制', 'error');
    if (question.type === 'text' && !empty && ([...value].length < (v.minLength ?? 0) || [...value].length > (v.maxLength ?? Infinity))) return toast('文本长度不符合限制', 'error');
    if (question.type === 'number' && !empty && (!Number.isFinite(value) || (v.integerOnly && !Number.isInteger(value)) || value < (v.min ?? -Infinity) || value > (v.max ?? Infinity))) return toast('数字不符合限制', 'error');
    if (empty) delete state.answers[question.order]; else state.answers[question.order] = value;
    const next = state.fillerRules.filter((rule) => rule.sourceOrder === question.order).sort((a, b) => a.priority - b.priority).find((rule) => conditionMatches(rule.condition, value));
    const nextOrder = next ? next.targetOrder : question.order + 1;
    const currentPathIndex = state.visitHistory.indexOf(question.order);
    const activePath = currentPathIndex < 0 ? state.visitHistory : state.visitHistory.slice(0, currentPathIndex + 1);
    if (activePath.includes(nextOrder) || nextOrder === question.order) return toast('检测到循环跳转，请修改问卷规则', 'error');
    state.visitHistory = activePath;
    if (!state.questions.some((item) => item.order === nextOrder)) return submitFill();
    state.visitHistory.push(nextOrder);
    state.currentOrder = nextOrder;
    renderFill();
  };
}
async function submitFill() { try { const visitedOrders = [...state.visitHistory]; await api(`/api/public-survey/${state.survey.shortId}/responses`, { method: 'POST', body: JSON.stringify({ answers: state.answers, visitedOrders }) }); $('#filler').innerHTML = '<div class="empty">提交成功，感谢你的回答。</div>'; toast('问卷已提交', 'success'); } catch (error) { toast(error.message, 'error'); } }

if (surveyRoute) openSurvey(decodeURIComponent(surveyRoute[1])); else if (state.token) loadDashboard().catch(logout);
