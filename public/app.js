if (typeof window === 'undefined' || typeof document === 'undefined') {
  console.error('public/app.js 是浏览器端脚本，请通过 npm start 启动服务后在浏览器访问网页，不要使用 node 直接运行。');
} else {
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
let storedVerificationFixture = null;
try { storedVerificationFixture = JSON.parse(localStorage.getItem('questionnaireVerificationFixture') || 'null'); } catch (_) { storedVerificationFixture = null; }
const state = { token: localStorage.getItem('questionnaireToken'), username: localStorage.getItem('questionnaireUser'), mode: 'login', questions: [], rules: [], banks: [], templates: [], surveyTemplates: [], editingShortId: null, editingTemplateId: null, templateEditMode: 'update', survey: null, answers: {}, currentOrder: 1, fillerRules: [], visitHistory: [], verificationFixture: storedVerificationFixture, verificationPromptPrefix: storedVerificationFixture?.promptPrefix || '' };
const surveyRoute = location.pathname.match(/^\/survey\/([^/]+)$/);

function safe(value) { return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
async function api(url, options = {}) {
  const response = await fetch(url, { cache: 'no-store', ...options, headers: { 'content-type': 'application/json', ...(state.token ? { authorization: `Bearer ${state.token}` } : {}), ...options.headers } });
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
  $('#libraryPanel').hidden = true; $('#surveyLibraryPanel').hidden = true; $('#builder').hidden = true; $('#casePanel').hidden = true; $('#templatePicker').hidden = true; $('#surveyList').hidden = false;
  try { renderSurveys(await api('/api/surveys')); } catch (error) { logout(error.message); }
}

async function loadTemplates() {
  try {
    const [templates, banks] = await Promise.all([api('/api/question-templates'), api('/api/question-banks')]);
    state.templates = Array.isArray(templates) ? templates.filter((item) => item && item.id) : [];
    state.banks = Array.isArray(banks) ? banks.filter((item) => item && item.id) : [];
    $('#templateBank').innerHTML = '<option value="">未归类</option>' + state.banks.map((bank) => `<option value="${bank.id}">${safe(bank.name)}</option>`).join('');
    const bankCounts = new Map();
    for (const template of state.templates) if (template.bankId) bankCounts.set(template.bankId, (bankCounts.get(template.bankId) || new Set()).add(template.rootQuestionId || template.id));
    $('#bankList').innerHTML = state.banks.length ? state.banks.map((bank) => `<div class="bank-row"><span>${safe(bank.name)} <small>（${bankCounts.get(bank.id)?.size || 0} 道题）</small></span><button class="danger" data-delete-bank="${bank.id}" type="button">删除题库</button></div>`).join('') : '<span class="muted">暂无题库，题目也可以先保存为未归类。</span>';
    const filterValue = $('#templateBankFilter').value;
    $('#templateBankFilter').innerHTML = '<option value="">全部题库</option><option value="__uncategorized">未归类</option>' + state.banks.map((bank) => `<option value="${bank.id}">${safe(bank.name)}</option>`).join('');
    $('#templateBankFilter').value = filterValue;
    const selectedTemplates = state.templates.filter((template) => !filterValue || (filterValue === '__uncategorized' ? !template.bankId : template.bankId === filterValue));
    const groups = new Map();
    for (const template of selectedTemplates) {
      const key = template.rootQuestionId || template.id;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(template);
    }
    $('#templateList').innerHTML = selectedTemplates.length ? [...groups.values()].map((versions) => {
      versions.sort((left, right) => right.version - left.version);
      const currentId = versions.find((item) => item.currentVersionId)?.currentVersionId;
      const latest = versions.find((item) => item.id === currentId) || versions[0];
      const question = latest.question && typeof latest.question === 'object' ? latest.question : {};
      const prompt = question.prompt || '（题目内容缺失）';
      const version = Number.isInteger(latest.version) ? latest.version : 1;
      return `<article class="template-row"><div><h3>${safe(prompt)}</h3><div class="survey-meta">当前 v${version}${latest.versionName ? ` · ${safe(latest.versionName)}` : ''} · ${safe(latest.bankName || '未归类')} · 共 ${versions.length}/10 个版本 · ${latest.visibility === 'shared' ? '已共享' : '私有'}</div></div><div class="template-actions"><button class="quiet" data-template-history="${latest.id}" type="button">版本历史</button><button class="quiet" data-edit-template="${latest.id}" type="button" ${latest.question ? '' : 'disabled'}>编辑题目</button><button class="quiet" data-clone-template="${latest.id}" type="button" ${latest.question ? '' : 'disabled'}>复制为新题目</button><button class="quiet" data-share-template="${latest.id}" type="button">共享</button><button class="quiet" data-template-usage="${latest.id}" type="button">查看使用</button><button class="quiet" data-template-stats="${latest.id}" type="button">跨问卷统计</button><button class="danger" data-delete-template="${latest.id}" type="button">删除题目</button></div></article>`;
    }).join('') : '<div class="empty">还没有可复用题目。</div>';
    $$('[data-template-history]').forEach((button) => button.onclick = async () => {
      try {
        const data = await api(`/api/question-templates/${encodeURIComponent(button.dataset.templateHistory)}/history`);
        renderTemplateHistory(data.versions);
      } catch (error) { toast(error.message, 'error'); }
    });
    $$('[data-template-usage]').forEach((button) => button.onclick = async () => {
      try { const data = await api(`/api/question-templates/${encodeURIComponent(button.dataset.templateUsage)}/usage`); toast(`该题已被 ${data.usages.length} 份问卷使用`, 'info'); } catch (error) { toast(error.message, 'error'); }
    });
    $$('[data-share-template]').forEach((button) => button.onclick = async () => {
      const username = window.prompt('请输入要共享给的用户名');
      if (!username) return;
      try { await api(`/api/question-templates/${encodeURIComponent(button.dataset.shareTemplate)}/share`, { method: 'POST', body: JSON.stringify({ username }) }); toast('题目已共享', 'success'); await loadTemplates(); } catch (error) { toast(error.message, 'error'); }
    });
    $$('[data-edit-template]').forEach((button) => button.onclick = () => beginTemplateEdit(state.templates.find((item) => item.id === button.dataset.editTemplate)));
    $$('[data-clone-template]').forEach((button) => button.onclick = () => beginTemplateClone(state.templates.find((item) => item.id === button.dataset.cloneTemplate)));
    $$('[data-template-stats]').forEach((button) => button.onclick = async () => {
      try { const data = await api(`/api/question-stats/${encodeURIComponent(button.dataset.templateStats)}`); $('#templateMessage').textContent = `跨问卷回答 ${data.responseCount} 条${data.average === null ? '' : `，数字平均值 ${data.average}`}`; } catch (error) { toast(error.message, 'error'); }
    });
    $$('[data-delete-bank]').forEach((button) => button.onclick = async () => {
      if (!window.confirm('确定删除这个空题库吗？题库中有题目时需要先移除题目归属。')) return;
      try { await api(`/api/question-banks/${encodeURIComponent(button.dataset.deleteBank)}`, { method: 'DELETE' }); toast('题库已删除', 'success'); await loadTemplates(); } catch (error) { toast(error.message, 'error'); }
    });
    $$('[data-delete-template]').forEach((button) => button.onclick = async () => {
      if (!window.confirm('确定删除整道题目及其全部版本吗？如果已有问卷使用，将无法删除。')) return;
      try { await api(`/api/question-templates/${encodeURIComponent(button.dataset.deleteTemplate)}/chain`, { method: 'DELETE' }); toast('题目及其全部版本已删除', 'success'); await loadTemplates(); } catch (error) { toast(error.message, 'error'); }
    });
  } catch (error) { $('#templateList').innerHTML = `<div class="empty">${safe(error.message)}</div>`; }
}

function renderTemplateHistory(versions) {
  if (!Array.isArray(versions)) {
    toast('题目历史数据格式无效，请刷新后重试', 'error');
    return;
  }
  $('#templateHistory').hidden = false;
  $('#templateHistoryDetail').hidden = true;
  $('#templateHistoryList').innerHTML = versions.map((template) => {
    const question = template.question && typeof template.question === 'object' ? template.question : {};
    const source = template.derivedFromVersion ? `基于 v${template.derivedFromVersion} 修改` : '初始版本';
    const restored = template.restoredFromVersion ? ` · 恢复自 v${template.restoredFromVersion}` : '';
    return `<article class="history-row"><button class="history-detail-button" data-history-detail="${template.id}" type="button"><strong>v${Number.isInteger(template.version) ? template.version : '?'}</strong>${template.current ? '（当前）' : ''} · ${safe(template.versionName || '未命名版本')} · ${safe(question.prompt || '（题目内容缺失）')}<span class="survey-meta">${source}${restored} · ${template.createdAt ? new Date(template.createdAt).toLocaleString() : '时间未知'}</span></button><div class="template-actions"><button class="quiet" data-restore-template="${template.id}" type="button" ${template.question && !template.current ? '' : 'disabled'}>回溯到此版本</button><button class="danger" data-delete-history-template="${template.id}" type="button" ${template.current ? 'disabled' : ''}>删除该版本</button></div></article>`;
  }).join('');
  $$('[data-history-detail]').forEach((button) => button.onclick = () => {
    const selected = versions.find((item) => item.id === button.dataset.historyDetail);
    if (!selected) return;
    const question = selected.question || {};
    $('#templateHistoryDetail').hidden = false;
    $('#templateHistoryDetail').innerHTML = `<h3>v${selected.version} 详情</h3><dl><dt>题干</dt><dd>${safe(question.prompt || '（缺失）')}</dd><dt>题型</dt><dd>${safe(question.type || '未知')}</dd><dt>必答</dt><dd>${question.required ? '是' : '否'}</dd><dt>选项</dt><dd>${question.options?.length ? question.options.map((option) => safe(option.text)).join('、') : '无'}</dd><dt>校验</dt><dd><code>${safe(JSON.stringify(question.validation || {}))}</code></dd></dl>`;
  });
  $$('[data-restore-template]').forEach((button) => button.onclick = async () => {
    if (!window.confirm('将当前题目回溯到这个版本吗？不会新增版本，旧版本仍保留。')) return;
    try {
      const restored = await api(`/api/question-templates/${encodeURIComponent(button.dataset.restoreTemplate)}/restore`, { method: 'POST' });
      toast(`已回溯到 v${restored.rolledBackToVersion}`, 'success');
      await loadTemplates();
      const history = await api(`/api/question-templates/${encodeURIComponent(restored.id)}/history`);
      renderTemplateHistory(history.versions);
    } catch (error) { toast(error.message, 'error'); }
  });
  $$('[data-delete-history-template]').forEach((button) => button.onclick = async () => {
    if (!window.confirm('删除该版本后将无法从历史中回溯到它，确定删除吗？')) return;
    try { await api(`/api/question-templates/${encodeURIComponent(button.dataset.deleteHistoryTemplate)}`, { method: 'DELETE' }); toast('版本已删除', 'success'); const anchor = versions.find((item) => item.id !== button.dataset.deleteHistoryTemplate); if (anchor) { const history = await api(`/api/question-templates/${encodeURIComponent(anchor.id)}/history`); renderTemplateHistory(history.versions); } await loadTemplates(); } catch (error) { toast(error.message, 'error'); }
  });
}

$('#libraryToggle').onclick = async () => { $('#builder').hidden = true; $('#casePanel').hidden = true; $('#surveyList').hidden = true; $('#libraryPanel').hidden = false; $('#libraryPanel').scrollIntoView({ behavior: 'smooth', block: 'start' }); await loadTemplates(); };
$('#libraryClose').onclick = loadDashboard;
$('#refreshTemplates').onclick = loadTemplates;
$('#templateBankFilter').onchange = loadTemplates;
$('#templateHistoryClose').onclick = () => { $('#templateHistory').hidden = true; };
async function loadSurveyTemplates() {
  try {
    state.surveyTemplates = await api('/api/survey-templates');
    $('#surveyTemplateList').innerHTML = state.surveyTemplates.length ? state.surveyTemplates.map((template) => `<article class="template-row"><div><h3>${safe(template.title)}</h3><div class="survey-meta">${template.questions.length} 道题 · 更新于 ${new Date(template.updatedAt).toLocaleString()}</div></div><div class="template-actions"><button class="primary" data-use-survey-template="${template.id}" type="button">基于此模板新建</button><button class="danger" data-delete-survey-template="${template.id}" type="button">删除模板</button></div></article>`).join('') : '<div class="empty">问卷库还没有模板。可在“我的问卷”中将草稿保存到问卷库。</div>';
    $$('[data-delete-survey-template]').forEach((button) => button.onclick = async () => {
      if (!window.confirm('确定删除这份问卷模板吗？已创建的问卷不会受影响。')) return;
      try { await api(`/api/survey-templates/${encodeURIComponent(button.dataset.deleteSurveyTemplate)}`, { method: 'DELETE' }); toast('问卷模板已删除', 'success'); await loadSurveyTemplates(); } catch (error) { toast(error.message, 'error'); }
    });
    $$('[data-use-survey-template]').forEach((button) => button.onclick = () => useSurveyTemplate(button.dataset.useSurveyTemplate));
  } catch (error) { $('#surveyTemplateList').innerHTML = `<div class="empty">${safe(error.message)}</div>`; }
}
$('#surveyLibraryToggle').onclick = async () => { $('#libraryPanel').hidden = true; $('#builder').hidden = true; $('#casePanel').hidden = true; $('#surveyList').hidden = true; $('#surveyLibraryPanel').hidden = false; await loadSurveyTemplates(); $('#surveyLibraryPanel').scrollIntoView({ behavior: 'smooth', block: 'start' }); };
$('#surveyLibraryClose').onclick = loadDashboard;
function useSurveyTemplate(id) {
  const template = state.surveyTemplates.find((item) => item.id === id);
  if (!template) return;
  if (state.questions.length && !window.confirm('使用问卷模板会替换当前尚未保存的编辑内容，是否继续？')) return;
  state.editingShortId = null;
  state.questions = template.questions.map((question) => ({ ...question, options: question.options?.map((option) => ({ ...option })) || [], validation: { ...(question.validation || {}) }, fillKind: question.type === 'number' ? 'number' : question.type === 'text' ? 'text' : undefined }));
  state.rules = template.jumpRules.map((rule) => ({ sourceOrder: rule.sourceOrder, targetOrder: rule.targetOrder, operator: rule.condition.operator, optionKeys: rule.condition.optionKeys || [], value: rule.condition.value, min: rule.condition.min, max: rule.condition.max, priority: rule.priority }));
  const form = $('#surveyForm'); form.reset(); form.elements.title.value = `${template.title}（副本）`; form.elements.description.value = template.description || ''; form.elements.allowAnonymous.checked = Boolean(template.allowAnonymous); form.elements.allowMultipleResponses.checked = Boolean(template.allowMultipleResponses);
  $('#templatePicker').hidden = true; $('#builder .section-head h2').textContent = '问卷设置'; renderQuestions(); renderRules(); openBuilder(); toast('已从问卷库创建新问卷草稿', 'success');
}
function renderTemplatePicker() {
  const filter = $('#templatePickerBankFilter').value;
  const templates = state.templates.filter((template) => template.question && (!filter || (filter === '__uncategorized' ? !template.bankId : template.bankId === filter)));
  $('#templatePickerList').innerHTML = templates.length ? templates.map((template) => `<article class="template-row"><div><h3>${safe(template.question.prompt || '（题目内容缺失）')}</h3><div class="survey-meta">v${template.version}${template.versionName ? ` · ${safe(template.versionName)}` : ''} · ${safe(template.bankName || '未归类')} · ${safe(template.question.type || '未知题型')}</div></div><button class="quiet" data-pick-template="${template.id}" type="button">加入此题</button></article>`).join('') : '<div class="empty">该题库中还没有可用题目。</div>';
  $$('[data-pick-template]').forEach((button) => button.onclick = () => { const template = state.templates.find((item) => item.id === button.dataset.pickTemplate); if (!template?.question) return; state.questions.push({ ...template.question, sourceTemplateId: template.id, sourceTemplateVersion: template.version }); $('#templatePicker').hidden = true; renderQuestions(); renderRules(); toast(`已加入“${template.question.prompt}”`, 'success'); });
}
$('#pickTemplate').onclick = async () => { $('#templatePicker').hidden = false; await loadTemplates(); const filter = $('#templatePickerBankFilter').value; $('#templatePickerBankFilter').innerHTML = '<option value="">全部题库</option><option value="__uncategorized">未归类</option>' + state.banks.map((bank) => `<option value="${bank.id}">${safe(bank.name)}</option>`).join(''); $('#templatePickerBankFilter').value = filter; renderTemplatePicker(); };
$('#templatePickerBankFilter').onchange = renderTemplatePicker;
$('#closeTemplatePicker').onclick = () => { $('#templatePicker').hidden = true; };
function beginTemplateEdit(template) {
  if (!template) return;
  state.editingTemplateId = template.id;
  state.templateEditMode = 'update';
  const form = $('#templateForm'); form.elements.prompt.value = template.question.prompt; form.elements.versionName.value = ''; form.elements.versionName.placeholder = `例如：${template.version + 1}月修订版`; form.elements.type.value = template.question.type; form.elements.bankId.value = template.bankId || ''; form.elements.required.checked = Boolean(template.question.required); form.elements.options.value = (template.question.options || []).map((option) => option.text).join('\n'); form.elements.minLength.value = template.question.type === 'text' ? (template.question.validation?.minLength ?? '') : template.question.validation?.min ?? ''; form.elements.maxLength.value = template.question.type === 'text' ? (template.question.validation?.maxLength ?? '') : template.question.validation?.max ?? ''; form.elements.minSelections.value = template.question.validation?.minSelections ?? ''; form.elements.maxSelections.value = template.question.validation?.maxSelections ?? ''; form.elements.integerOnly.value = template.question.validation?.integerOnly ? 'true' : 'false'; syncTemplateFields(); $('#templateSubmit').textContent = '保存版本'; $('#templateCancelEdit').hidden = false; $('#templateForm').scrollIntoView({ behavior: 'smooth', block: 'start' }); }
function beginTemplateClone(template) {
  if (!template) return;
  state.editingTemplateId = template.id;
  state.templateEditMode = 'clone';
  beginTemplateEdit(template);
  state.templateEditMode = 'clone';
  $('#templateSubmit').textContent = '保存为新题目';
}
$('#templateCancelEdit').onclick = () => { state.editingTemplateId = null; state.templateEditMode = 'update'; $('#templateForm').reset(); $('#templateForm').elements.versionName.placeholder = '例如：适用于 2026 年调查'; syncTemplateFields(); $('#templateSubmit').textContent = '保存为新题目'; $('#templateCancelEdit').hidden = true; };
function syncTemplateFields() {
  const type = $('#templateForm').elements.type.value;
  const choice = type === 'single_choice' || type === 'multiple_choice';
  const number = type === 'number';
  $('#templateOptionsField').hidden = !choice;
  $('#templateChoiceValidation').hidden = !choice || type === 'single_choice';
  $('#templateFillValidation').hidden = choice;
  $('#templateIntegerField').hidden = !number;
  $('#templateForm').elements.options.required = choice;
}
$('#templateForm').elements.type.onchange = syncTemplateFields;
syncTemplateFields();
$('#templateForm').onsubmit = async (event) => {
  event.preventDefault(); const formElement = event.currentTarget; const form = new FormData(formElement); const type = form.get('type');
  const options = String(form.get('options') || '').split('\n').map((text, index) => ({ key: `option_${index + 1}`, text: text.trim(), order: index + 1 })).filter((option) => option.text);
  const validation = type === 'text' ? { ...(form.get('minLength') !== '' ? { minLength: Number(form.get('minLength')) } : {}), ...(form.get('maxLength') !== '' ? { maxLength: Number(form.get('maxLength')) } : {}) } : type === 'number' ? { ...(form.get('minLength') !== '' ? { min: Number(form.get('minLength')) } : {}), ...(form.get('maxLength') !== '' ? { max: Number(form.get('maxLength')) } : {}), integerOnly: form.get('integerOnly') === 'true' } : type === 'multiple_choice' ? { minSelections: Number(form.get('minSelections') || 0), maxSelections: Number(form.get('maxSelections') || options.length) } : {};
  try { const editMode = state.templateEditMode; const path = state.editingTemplateId ? `/api/question-templates/${encodeURIComponent(state.editingTemplateId)}/${editMode === 'clone' ? 'clone' : 'versions'}` : '/api/question-templates'; const saved = await api(path, { method: 'POST', body: JSON.stringify({ versionName: form.get('versionName'), ...(form.get('bankId') ? { bankId: form.get('bankId') } : {}), question: { type, prompt: form.get('prompt'), required: form.has('required'), options, validation } }) }); formElement.reset(); state.editingTemplateId = null; state.templateEditMode = 'update'; syncTemplateFields(); $('#templateSubmit').textContent = '保存为新题目'; $('#templateCancelEdit').hidden = true; toast(editMode === 'clone' ? '已复制为新题目' : '同一题目的新版本已保存', 'success'); await loadTemplates(); if (editMode === 'update') { const history = await api(`/api/question-templates/${encodeURIComponent(saved.id)}/history`); renderTemplateHistory(history.versions); } } catch (error) { $('#templateMessage').textContent = error.message; toast(error.message, 'error'); }
};
$('#bankForm').onsubmit = async (event) => {
  event.preventDefault(); const formElement = event.currentTarget; const form = new FormData(formElement);
  try { await api('/api/question-banks', { method: 'POST', body: JSON.stringify({ name: form.get('name') }) }); formElement.reset(); toast('题库已创建', 'success'); await loadTemplates(); } catch (error) { toast(error.message, 'error'); }
};
function renderSurveys(surveys) {
  $('#surveyList').innerHTML = surveys.length ? surveys.map((survey) => {
    const shareUrl = `${location.origin}/survey/${encodeURIComponent(survey.shortId)}`;
    const publishedActions = `<div class="share-area"><code class="share-url">${safe(shareUrl)}</code><div class="share-actions"><button class="quiet" data-copy-link="${safe(shareUrl)}" type="button">复制链接</button><a class="share" href="/survey/${encodeURIComponent(survey.shortId)}" target="_blank" rel="noopener">打开链接</a></div></div>`;
    return `<article class="survey-row"><div><h3>${safe(survey.title)}</h3><div class="survey-meta"><span class="status ${survey.status}">${survey.status === 'published' ? '已发布' : '草稿'}</span> ${new Date(survey.updatedAt).toLocaleString()}</div>${survey.status === 'published' ? publishedActions : ''}</div><div class="survey-actions">${survey.status === 'draft' ? `<button class="quiet" data-edit="${survey.shortId}" type="button">继续编辑</button><button class="quiet" data-save-survey-template="${survey.shortId}" data-survey-title="${safe(survey.title)}" type="button">存入问卷库</button><button class="primary" data-publish="${survey.shortId}" type="button">发布</button>` : ''}<button class="quiet" data-stats="${survey.shortId}" type="button">统计</button></div></article>`;
  }).join('') : '<div class="empty">还没有问卷，创建第一份问卷开始使用。</div>';
  $$('[data-stats]').forEach((button) => button.onclick = () => showStats(button.dataset.stats));
  $$('[data-edit]').forEach((button) => button.onclick = () => editDraft(button.dataset.edit));
  $$('[data-publish]').forEach((button) => button.onclick = () => editDraft(button.dataset.publish, true));
  $$('[data-save-survey-template]').forEach((button) => button.onclick = async () => {
    const title = window.prompt('问卷库模板名称', button.dataset.surveyTitle);
    if (!title?.trim()) return;
    try { await api('/api/survey-templates', { method: 'POST', body: JSON.stringify({ sourceShortId: button.dataset.saveSurveyTemplate, title: title.trim() }) }); toast('已保存到问卷库', 'success'); } catch (error) { toast(error.message, 'error'); }
  });
  $$('[data-copy-link]').forEach((button) => button.onclick = async () => {
    try { await navigator.clipboard.writeText(button.dataset.copyLink); toast('链接已复制', 'success'); }
    catch { toast('复制失败，请手动复制链接', 'error'); }
  });
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
  const verificationQuery = `verification=${Date.now()}&verificationToken=${encodeURIComponent(state.token || '')}`;
  frame.src = `/survey/${encodeURIComponent(shortId)}?${verificationQuery}`;
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
  const verificationQuery = `verification=${Date.now()}&verificationToken=${encodeURIComponent(state.token || '')}`;
  frame.src = `/survey/${encodeURIComponent(shortId)}?${verificationQuery}`;
  await loaded;
  // 浏览器隐私策略可能让新 iframe 暂时读不到父页面令牌，主动同步后重载填写页。
  if (!frame.contentDocument?.querySelector('[name="answer"]') && frame.contentDocument?.querySelector('#authPane:not([hidden])')) {
    frame.contentWindow.localStorage.setItem('questionnaireToken', state.token || '');
    frame.contentWindow.localStorage.setItem('questionnaireUser', state.username || '');
    frame.src = `/survey/${encodeURIComponent(shortId)}?${verificationQuery}`;
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('填写页面重新加载超时')), 8000);
      frame.onload = () => { clearTimeout(timeout); resolve(); };
      frame.onerror = () => { clearTimeout(timeout); reject(new Error('填写页面重新加载失败')); };
    });
  }
  const waitForAnswer = async () => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < 10000) {
      const doc = frame.contentDocument;
      const input = doc?.querySelector('[name="answer"]');
      if (input && doc.querySelector('.answer-card h2')) return input;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const text = frame.contentDocument?.body?.innerText?.trim().slice(0, 240) || '页面无内容';
    throw new Error(`填写页第1题未渲染（页面状态：${text}）`);
  };
  const input = await waitForAnswer();
  const value = branch === 'yes' ? 20 : 17;
  const expectedPrompt = `${state.verificationPromptPrefix}${branch === 'yes' ? '到达路径' : '跳过路径'}`;
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
function clearVerificationFixture() {
  state.verificationFixture = null;
  state.verificationPromptPrefix = '';
  localStorage.removeItem('questionnaireVerificationFixture');
  $('#deleteCases').hidden = true;
}

async function clearStaleVerificationFixture() {
  const fixture = state.verificationFixture;
  if (!fixture?.surveyShortId) return false;
  try {
    await api(`/api/surveys/${encodeURIComponent(fixture.surveyShortId)}/edit`);
    return false;
  } catch (error) {
    if (error.status !== 404) return false;
    clearVerificationFixture();
    toast('已清除不存在的旧测试数据标记', 'info');
    return true;
  }
}

async function deleteVerificationFixture() {
  const fixture = state.verificationFixture;
  if (!fixture) return toast('当前没有可删除的测试数据', 'info');
  if (!window.confirm('确定删除本次功能验证创建的测试用问卷、题目和题库吗？')) return;
  const errors = [];
  const remove = async (path) => {
    try { await api(path, { method: 'DELETE' }); }
    catch (error) { if (error.status !== 404) errors.push(error.message); }
  };
  if (fixture.surveyShortId) await remove(`/api/surveys/${encodeURIComponent(fixture.surveyShortId)}`);
  if (fixture.templateId) await remove(`/api/question-templates/${encodeURIComponent(fixture.templateId)}/chain`);
  if (fixture.bankId) await remove(`/api/question-banks/${encodeURIComponent(fixture.bankId)}`);
  if (errors.length) return toast(`测试数据删除部分失败：${errors.join('；')}`, 'error');
  clearVerificationFixture(); toast('测试数据已删除', 'success'); await loadDashboard();
}
$('#deleteCases').onclick = deleteVerificationFixture;
$('#deleteCases').hidden = !state.verificationFixture;
$('#runCases').onclick = async () => {
  const button = $('#runCases');
  const results = [];
  let shortId;
  let verificationBankId;
  let verificationTemplateId;
  const record = async (name, action) => {
    try { const evidence = await action(); results.push({ name, ok: true, evidence }); }
    catch (error) { results.push({ name, ok: false, evidence: error.evidence || { error: error.message, status: error.status, response: error.body } }); }
    finally { renderCaseResults(results); }
  };
  await clearStaleVerificationFixture();
  if (state.verificationFixture) return toast('请先点击“一键删除测试数据”，再运行新一轮验证', 'error');
  button.disabled = true;
  button.textContent = '验证中...';
  $('#caseResults').innerHTML = '<p class="muted">正在执行核心流程验证...</p>';
  try {
    const marker = '测试用功能验证';
    state.verificationPromptPrefix = marker;
    const draft = {
      title: `${marker}问卷`, description: '此问卷由功能验证创建，删除测试数据后清理。', allowAnonymous: false, allowMultipleResponses: true, status: 'draft',
      questions: [
        { type: 'single_choice', prompt: '是否继续？', required: true, options: [{ key: 'yes', text: '继续', order: 1 }, { key: 'no', text: '结束', order: 2 }], validation: {} },
        { type: 'text', prompt: '意见', required: true, validation: { minLength: 2, maxLength: 30 } },
        { type: 'number', prompt: '评分', required: true, validation: { min: 1, max: 5, integerOnly: true } }
      ],
      jumpRules: [{ sourceOrder: 1, targetOrder: 3, priority: 1, condition: { answerType: 'single_choice', operator: 'equals', optionKeys: ['yes'] } }]
    };
    draft.questions = [
      { type: 'number', prompt: `${marker}年龄阈值`, required: true, validation: { min: 0, max: 120, integerOnly: true } },
      { type: 'text', prompt: `${marker}跳过路径`, required: true, validation: { minLength: 2, maxLength: 30 } },
      { type: 'text', prompt: `${marker}到达路径`, required: true, validation: { minLength: 2, maxLength: 30 } },
      { type: 'number', prompt: `${marker}评分`, required: true, validation: { min: 1, max: 5, integerOnly: true } }
    ];
    draft.jumpRules = [{ sourceOrder: 1, targetOrder: 3, priority: 1, condition: { answerType: 'number', operator: 'gte', value: 18 } }];
    await record('保存草稿', async () => {
      const evidence = assertStatus(await verificationRequest('POST', '/api/surveys', draft), 201);
      shortId = evidence.response.body.shortId;
      state.verificationFixture = { surveyShortId: shortId, promptPrefix: marker }; localStorage.setItem('questionnaireVerificationFixture', JSON.stringify(state.verificationFixture));
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
      evidence.assertion = { expectedStatus: 400, actualStatus: evidence.response.status, expectedErrorContains: `${marker}评分`, actualError: evidence.response.body.error, passed: evidence.response.status === 400 && evidence.response.body.error?.includes(`${marker}评分`) };
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
    await record('题库与版本专项验证', async () => {
      const bankEvidence = assertStatus(await verificationRequest('POST', '/api/question-banks', { name: `${marker}题库` }), 201);
      verificationBankId = bankEvidence.response.body.id;
      state.verificationFixture.bankId = verificationBankId;
      localStorage.setItem('questionnaireVerificationFixture', JSON.stringify(state.verificationFixture));
      const duplicate = await verificationRequest('POST', '/api/question-banks', { name: bankEvidence.response.body.name });
      duplicate.assertion = { expectedStatus: 409, actualStatus: duplicate.response.status, passed: duplicate.response.status === 409 };
      if (!duplicate.assertion.passed) throw Object.assign(new Error('重复题库名称未被拒绝'), { evidence: duplicate });
      const templateEvidence = assertStatus(await verificationRequest('POST', '/api/question-templates', { bankId: verificationBankId, question: { type: 'text', prompt: `${marker}版本验证`, required: false, validation: {} } }), 201);
      verificationTemplateId = templateEvidence.response.body.id;
      state.verificationFixture.templateId = verificationTemplateId;
      localStorage.setItem('questionnaireVerificationFixture', JSON.stringify(state.verificationFixture));
      const listEvidence = await verificationRequest('GET', '/api/question-templates');
      const listedTemplate = listEvidence.response.body.find((item) => item.id === verificationTemplateId);
      listEvidence.assertion = { expectedBankName: bankEvidence.response.body.name, actualBankName: listedTemplate?.bankName, passed: listEvidence.response.status === 200 && listedTemplate?.bankName === bankEvidence.response.body.name };
      if (!listEvidence.assertion.passed) throw Object.assign(new Error('题目列表没有显示所属题库'), { evidence: listEvidence });
      const versionEvidence = assertStatus(await verificationRequest('POST', `/api/question-templates/${verificationTemplateId}/versions`, { versionName: `${marker}修订版`, question: { type: 'text', prompt: `${marker}版本验证更新`, required: false, validation: {} } }), 201);
      const historyEvidence = await verificationRequest('GET', `/api/question-templates/${versionEvidence.response.body.id}/history`);
      historyEvidence.assertion = { expected: { versionCount: 2, currentVersion: 2, bankName: bankEvidence.response.body.name }, actual: { versionCount: historyEvidence.response.body.versions?.length, currentVersion: historyEvidence.response.body.versions?.find((item) => item.current)?.version, bankName: templateEvidence.response.body.bankName }, passed: historyEvidence.response.status === 200 && historyEvidence.response.body.versions?.length === 2 && historyEvidence.response.body.versions?.some((item) => item.current && item.version === 2) };
      if (!historyEvidence.assertion.passed) throw Object.assign(new Error('题库版本历史或当前指针异常'), { evidence: historyEvidence });
      return { bank: bankEvidence, duplicate, template: templateEvidence, list: listEvidence, version: versionEvidence, history: historyEvidence };
    });
  } catch (_) {
    // Individual failed steps are already shown in the panel.
  } finally {
    if (state.verificationFixture) { $('#deleteCases').hidden = false; }
    $('#caseBrowser').replaceChildren();
    button.disabled = false;
    button.textContent = '运行验证';
    try { renderSurveys(await api('/api/surveys')); } catch (error) { toast(`验证后刷新问卷失败：${error.message}`, 'error'); }
  }
};

function newQuestion(type) {
  if (type === 'fill') return { type: 'text', fillKind: 'text', prompt: '', required: false, validation: { minLength: 0, maxLength: 500 } };
  return { type, prompt: '', required: false, options: [{ key: 'option_1', text: '选项一', order: 1 }, { key: 'option_2', text: '选项二', order: 2 }], validation: type === 'multiple_choice' ? { minSelections: 0, maxSelections: 2 } : {} };
}
function isChoice(question) { return question.type === 'single_choice' || question.type === 'multiple_choice'; }
function questionKind(question) { return isChoice(question) ? question.type : 'fill'; }
function normalizeRuleState() { state.rules = state.rules.filter((rule) => rule.sourceOrder <= state.questions.length && rule.targetOrder <= state.questions.length); }

function openBuilder() { $('#libraryPanel').hidden = true; $('#surveyLibraryPanel').hidden = true; $('#casePanel').hidden = true; $('#surveyList').hidden = true; $('#builder').hidden = false; $('#builder').scrollIntoView({ behavior: 'smooth', block: 'start' }); }
$('#createToggle').onclick = () => { state.editingShortId = null; state.questions = []; state.rules = []; $('#surveyForm').reset(); $('#builder .section-head h2').textContent = '问卷设置'; renderQuestions(); renderRules(); openBuilder(); };
$('#builderClose').onclick = () => { $('#builder').hidden = true; state.editingShortId = null; loadDashboard(); };
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
async function openSurvey(shortId) { const verificationToken = new URLSearchParams(location.search).get('verificationToken'); if (!state.token && verificationToken) state.token = verificationToken; if (!state.token) { showView('authPane'); authMessage('请先登录后填写问卷。'); return; } try { const data = await api(`/api/public-survey/${shortId}`); state.survey = data.survey; state.questions = data.questions; state.fillerRules = data.jumpRules; state.answers = {}; state.currentOrder = data.questions[0]?.order || 1; state.visitHistory = state.currentOrder ? [state.currentOrder] : []; renderFill(); } catch (error) { showView('filler'); $('#filler').innerHTML = `<div class="empty">${safe(error.message)}</div>`; } }
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
}
