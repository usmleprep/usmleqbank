/* ============================================
   USMLE QBANK — Complete Application
   ============================================ */

const App = (() => {
    // ===== STATE =====
    const state = {
        screen: 'dashboard',
        questionCache: {},
        currentTest: null,
        currentQuestionIdx: 0,
        timerInterval: null,
        timerSeconds: 0,
        questionTimers: {},
        calcValue: '',
        fontSize: 16,
        highlightMode: false,
        navigatorOpen: false,
    };

    // ===== PERSISTENCE =====
    function getPrefix() {
        return (typeof Auth !== 'undefined' && Auth.getUserPrefix) ? Auth.getUserPrefix() : 'usmle_';
    }
    function loadData(key, def) {
        try { return JSON.parse(localStorage.getItem(getPrefix() + key)) || def; }
        catch { return def; }
    }
    function saveData(key, val) {
        localStorage.setItem(getPrefix() + key, JSON.stringify(val));
    }

    // Persistent stores
    let testHistory = loadData('testHistory', []);
    let performance = loadData('performance', {});
    let questionStatus = loadData('questionStatus', {}); // id -> { answered, correct, userAnswer, flagged, timeSpent }
    let notes = loadData('notes', {});
    let usedQuestions = loadData('usedQuestions', []);

    function savePersist() {
        saveData('testHistory', testHistory);
        saveData('performance', performance);
        saveData('questionStatus', questionStatus);
        saveData('notes', notes);
        saveData('usedQuestions', usedQuestions);
        debouncedSync();
    }

    // ===== SERVER SYNC =====
    let _syncTimer = null;
    function debouncedSync() {
        clearTimeout(_syncTimer);
        _syncTimer = setTimeout(() => syncToServer(), 2000);
    }

    async function syncToServer() {
        const token = (typeof Auth !== 'undefined' && Auth.getToken) ? Auth.getToken() : null;
        if (!token) return;
        try {
            await fetch('/api/data/sync', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + token,
                },
                body: JSON.stringify({
                    testHistory,
                    questionStatus,
                    notes,
                    usedQuestions,
                    performance,
                }),
            });
        } catch (e) { console.warn('Sync to server failed:', e); }
    }

    async function loadFromServer() {
        const token = (typeof Auth !== 'undefined' && Auth.getToken) ? Auth.getToken() : null;
        if (!token) return;
        try {
            const res = await fetch('/api/data/sync', {
                headers: { 'Authorization': 'Bearer ' + token },
            });
            if (!res.ok) return;
            const data = await res.json();
            if (data && data.testHistory) {
                testHistory = data.testHistory;
                questionStatus = data.questionStatus || {};
                notes = data.notes || {};
                usedQuestions = data.usedQuestions || [];
                performance = data.performance || {};
                // Write into localStorage as cache
                savePersistLocal();
                // Re-render current screen
                if (state.screen === 'dashboard') navigate('dashboard');
            }
        } catch (e) { console.warn('Load from server failed:', e); }
    }

    // Save to localStorage only (no server sync) — used after loading from server
    function savePersistLocal() {
        saveData('testHistory', testHistory);
        saveData('performance', performance);
        saveData('questionStatus', questionStatus);
        saveData('notes', notes);
        saveData('usedQuestions', usedQuestions);
    }

    // ===== TOPICS HELPER =====
    function getAllQuestionIds() {
        const ids = new Set();
        for (const topic of Object.keys(topics)) {
            for (const sub of Object.keys(topics[topic])) {
                for (const id of topics[topic][sub]) {
                    ids.add(id);
                }
            }
        }
        return [...ids];
    }

    function getTopicForQuestion(qid) {
        for (const topic of Object.keys(topics)) {
            for (const sub of Object.keys(topics[topic])) {
                if (topics[topic][sub].includes(qid)) {
                    return { topic, subtopic: sub };
                }
            }
        }
        return { topic: 'Unknown', subtopic: 'Unknown' };
    }

    function countTopicQuestions(topicName) {
        let count = 0;
        if (topics[topicName]) {
            for (const sub of Object.keys(topics[topicName])) {
                count += topics[topicName][sub].length;
            }
        }
        return count;
    }

    function getSubtopicQuestions(topicName, subtopicName) {
        return topics[topicName]?.[subtopicName] || [];
    }

    const allIds = getAllQuestionIds();

    // ===== QUESTION PARSER =====
    async function fetchQuestion(id) {
        if (state.questionCache[id]) return state.questionCache[id];

        try {
            const resp = await fetch(`questions/${id}.html`);
            if (!resp.ok) return null;
            const html = await resp.text();
            const parsed = parseQuestionHTML(html, id);
            if (parsed) state.questionCache[id] = parsed;
            return parsed;
        } catch (e) {
            console.error(`Failed to load question ${id}:`, e);
            return null;
        }
    }

    function parseQuestionHTML(html, qid) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');

        const mainDetails = doc.querySelector('details');
        if (!mainDetails) return null;

        const children = [...mainDetails.children];
        const toggleUl = mainDetails.querySelector('ul.toggle');

        let stemParts = [];
        let choicesTable = null;
        let stemImages = [];

        for (const el of children) {
            if (el.tagName === 'SUMMARY') continue;
            if (el === toggleUl) break;

            // Check if answer choices table
            if (el.tagName === 'TABLE') {
                const firstCell = el.querySelector('td');
                if (firstCell && /^[A-F]\.\s*$/.test(firstCell.textContent.trim())) {
                    choicesTable = el;
                    continue;
                }
            }

            // Collect images from stem
            const imgs = el.querySelectorAll('img');
            imgs.forEach(img => {
                if (img.src) stemImages.push(img.src);
            });

            stemParts.push(el.outerHTML);
        }

        // Parse choices
        const choices = [];
        if (choicesTable) {
            const rows = choicesTable.querySelectorAll('tr');
            rows.forEach(row => {
                const cells = row.querySelectorAll('td');
                if (cells.length >= 2) {
                    const letter = cells[0].textContent.trim().replace('.', '');
                    const text = cells[1].textContent.trim();
                    if (letter && text) {
                        choices.push({ letter, text });
                    }
                }
            });
        }

        // Parse submit / explanation section
        let correctAnswer = '';
        let percentCorrect = 0;
        let explanationHTML = '';
        let subject = '';
        let system = '';
        let topicName = '';
        let choicePercentages = {};
        let explanationImages = [];

        const submitDetails = toggleUl?.querySelector('details');
        if (submitDetails) {
            // Answer table with percentages
            const answerTable = submitDetails.querySelector('table');
            if (answerTable) {
                const rows = answerTable.querySelectorAll('tr');
                rows.forEach(row => {
                    const cells = row.querySelectorAll('td');
                    if (cells.length >= 2) {
                        const letter = cells[0].textContent.trim().replace('.', '');
                        const textWithPct = cells[1].textContent.trim();
                        const pctMatch = textWithPct.match(/\((\d+)%\)/);
                        if (pctMatch) {
                            choicePercentages[letter] = parseInt(pctMatch[1]);
                        }
                    }
                });
            }

            // Parse paragraphs for metadata
            const allP = submitDetails.querySelectorAll('p');
            const pTexts = [...allP].map(p => ({ text: p.textContent.trim(), html: p.innerHTML }));

            let explanationParts = [];
            let metadataPhase = false;
            let eduObjective = '';
            let collectExplanation = false;

            for (let i = 0; i < pTexts.length; i++) {
                const t = pTexts[i].text;
                const h = pTexts[i].html;

                // Correct answer
                const correctMatch = t.match(/Correct answer\s*([A-F])/i);
                if (correctMatch) {
                    correctAnswer = correctMatch[1];
                    continue;
                }

                // Percent answered correctly
                const pctMatch = t.match(/(\d+)%\s*Answered\s*correctly/i);
                if (pctMatch) {
                    percentCorrect = parseInt(pctMatch[1]);
                    continue;
                }

                // Skip non-content paragraphs
                if (/^\d+\s*secs?\s*Time\s*Spent/i.test(t)) continue;
                if (/Version$/i.test(t)) continue;
                if (t === 'Incorrect' || t === 'Correct') continue;
                if (t === 'Explanation' || t === '') continue;
                if (t === 'My Notebook' || t === 'Flashcards' || t === 'Feedback') continue;
                if (t === 'Suspend' || t === 'End Block') continue;
                if (/^✨/.test(t)) continue;
                if (/Exhibit Display/i.test(t)) continue;
                if (/Zoom In|Zoom Out|Reset/i.test(t)) continue;
                if (/^Existing/i.test(t)) continue;
                if (/^0$/.test(t)) continue;
                if (/Copyright/i.test(t)) continue;

                // Educational objective
                if (t === 'Educational objective:') {
                    if (i + 1 < pTexts.length) {
                        eduObjective = pTexts[i + 1].html;
                    }
                    continue;
                }

                // Subject, System, Topic metadata
                if (t === 'Subject') { metadataPhase = true; continue; }
                if (t === 'System') { continue; }
                if (t === 'Topic') { continue; }

                if (metadataPhase) {
                    // Metadata values
                    if (!subject) { subject = t; continue; }
                    if (!system) { system = t; continue; }
                    if (!topicName) { topicName = t; continue; }
                    continue;
                }

                // If we got past the edu objective
                if (eduObjective && !metadataPhase) {
                    continue;
                }

                // Explanation content
                explanationParts.push(h);
            }

            // Collect explanation tables too
            const allTables = submitDetails.querySelectorAll('table');
            let tableHTML = '';
            for (let ti = 1; ti < allTables.length; ti++) {
                tableHTML += allTables[ti].outerHTML;
            }

            // Collect explanation images
            const expImgs = submitDetails.querySelectorAll('figure img, img');
            expImgs.forEach(img => {
                if (img.src && !stemImages.includes(img.src)) {
                    explanationImages.push(img.src);
                }
            });

            // Build explanation HTML
            explanationHTML = '';
            if (tableHTML) explanationHTML += tableHTML;
            explanationHTML += explanationParts.map(p => `<p>${p}</p>`).join('');
            if (eduObjective) {
                explanationHTML += `<div class="edu-objective"><strong>Educational Objective</strong>${eduObjective}</div>`;
            }
        }

        // Determine topic info from topics.js if not parsed
        const topicInfo = getTopicForQuestion(qid);

        return {
            id: qid,
            stem: stemParts.join(''),
            stemImages,
            choices,
            correctAnswer,
            percentCorrect,
            explanation: explanationHTML,
            explanationImages,
            choicePercentages,
            subject: subject || topicInfo.topic,
            system: system || topicInfo.topic,
            topic: topicName || topicInfo.subtopic,
        };
    }

    // ===== NAVIGATION =====
    function navigate(screen) {
        state.screen = screen;

        // Close sidebar on mobile when navigating
        closeSidebar();

        document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
        const target = document.getElementById('screen-' + screen);
        if (target) target.classList.add('active');

        document.querySelectorAll('.menu-item').forEach(m => {
            m.classList.toggle('active', m.dataset.screen === screen);
        });

        renderScreen(screen);
    }

    function renderScreen(screen) {
        switch (screen) {
            case 'dashboard': renderDashboard(); break;
            case 'create': renderCreateTest(); break;
            case 'test': break; // rendered separately
            case 'results': break;
            case 'performance': renderPerformance(); break;
            case 'search': renderSearch(); break;
            case 'previous': renderPreviousTests(); break;
            case 'notebook': renderNotebook(); break;
        }
        updateSidebarStats();
    }

    function updateSidebarStats() {
        document.getElementById('sidebar-total').textContent = allIds.length;
        document.getElementById('sidebar-used').textContent = usedQuestions.length;
    }

    // ===== DASHBOARD =====
    function renderDashboard() {
        const el = document.getElementById('screen-dashboard');
        const totalQ = allIds.length;
        const answeredQ = Object.keys(questionStatus).filter(k => questionStatus[k].answered).length;
        const correctQ = Object.keys(questionStatus).filter(k => questionStatus[k].correct).length;
        const pct = answeredQ > 0 ? Math.round((correctQ / answeredQ) * 100) : 0;
        const remaining = totalQ - answeredQ;

        const circumference = 2 * Math.PI * 70;
        const offset = circumference - (pct / 100) * circumference;

        // Recent tests (last 5)
        const recent = testHistory.slice(-5).reverse();

        el.innerHTML = `
            <div class="page-header">
                <h1>Dashboard</h1>
                <p>Your USMLE Step 1 question bank overview</p>
            </div>

            <div class="stats-row">
                <div class="stat-card">
                    <div class="stat-label">Total Questions</div>
                    <div class="stat-value">${totalQ.toLocaleString()}</div>
                    <div class="stat-sub">in ${Object.keys(topics).length} subjects</div>
                </div>
                <div class="stat-card">
                    <div class="stat-label">Answered</div>
                    <div class="stat-value">${answeredQ.toLocaleString()}</div>
                    <div class="stat-sub">${Math.round((answeredQ/totalQ)*100)}% complete</div>
                </div>
                <div class="stat-card">
                    <div class="stat-label">Correct</div>
                    <div class="stat-value">${pct}%</div>
                    <div class="stat-sub">${correctQ} of ${answeredQ} correct</div>
                </div>
                <div class="stat-card">
                    <div class="stat-label">Remaining</div>
                    <div class="stat-value">${remaining.toLocaleString()}</div>
                    <div class="stat-sub">unused questions</div>
                </div>
            </div>

            <div class="grid grid-2">
                <div class="card">
                    <div class="card-title">📊 Overall Progress</div>
                    <div class="progress-ring-container">
                        <div class="progress-ring">
                            <svg viewBox="0 0 160 160" width="160" height="160">
                                <circle class="bg" cx="80" cy="80" r="70"/>
                                <circle class="fg" cx="80" cy="80" r="70"
                                    stroke-dasharray="${circumference}"
                                    stroke-dashoffset="${offset}"/>
                            </svg>
                            <div class="center-text">
                                <span class="pct">${pct}%</span>
                                <span class="pct-label">Correct Rate</span>
                            </div>
                        </div>
                    </div>
                    <div style="text-align:center; margin-top:10px">
                        <span class="badge badge-green">${correctQ} Correct</span>
                        <span class="badge badge-red">${answeredQ - correctQ} Incorrect</span>
                        <span class="badge badge-blue">${remaining} Unused</span>
                    </div>
                </div>

                <div class="card">
                    <div class="card-title">📝 Recent Tests</div>
                    ${recent.length === 0 ? `
                        <div class="empty-state" style="padding:30px">
                            <div class="empty-icon">📋</div>
                            <h3>No tests yet</h3>
                            <p>Create your first test to start studying!</p>
                        </div>
                    ` : recent.map(t => `
                        <div class="results-q-item" onclick="App.reviewTest('${t.id}')">
                            <div class="results-q-icon ${t.score >= 70 ? 'correct-icon' : 'incorrect-icon'}">
                                ${t.score >= 70 ? '✓' : '✗'}
                            </div>
                            <div class="results-q-info">
                                <div class="q-num">${t.score}% — ${t.correct}/${t.answered || t.total} correct</div>
                                <div class="q-topic">${t.mode} · ${new Date(t.date).toLocaleDateString()}</div>
                            </div>
                        </div>
                    `).join('')}
                </div>
            </div>

            <div class="card" style="margin-top:8px">
                <div class="card-title">📈 Performance by Subject</div>
                <div id="dash-perf-bars"></div>
            </div>

            <div style="text-align:center; margin-top:24px">
                <button class="btn btn-primary btn-lg" onclick="App.navigate('create')">
                    + Create New Test
                </button>
            </div>
        `;

        // Render performance bars
        renderPerfBars('dash-perf-bars');
    }

    function renderPerfBars(containerId) {
        const container = document.getElementById(containerId);
        if (!container) return;

        let html = '';
        for (const topic of Object.keys(topics)) {
            const qIds = [];
            for (const sub of Object.keys(topics[topic])) {
                qIds.push(...topics[topic][sub]);
            }
            const answered = qIds.filter(id => questionStatus[id]?.answered).length;
            const correct = qIds.filter(id => questionStatus[id]?.correct).length;
            const pct = answered > 0 ? Math.round((correct / answered) * 100) : 0;
            const barClass = pct >= 70 ? 'good' : pct >= 50 ? 'medium' : 'poor';

            html += `
                <div class="perf-bar-row">
                    <div class="perf-bar-label" title="${topic}">${topic}</div>
                    <div class="perf-bar-track">
                        <div class="perf-bar-fill ${answered > 0 ? barClass : ''}" style="width: ${answered > 0 ? Math.max(pct, 8) : 0}%">
                            ${answered > 0 ? pct + '%' : ''}
                        </div>
                    </div>
                    <div class="perf-bar-value">${answered > 0 ? `${correct}/${answered}` : '—'}</div>
                </div>
            `;
        }
        container.innerHTML = html || '<div class="empty-state"><p>No data yet</p></div>';
    }

    // ===== CREATE TEST =====
    let selectedSubtopics = {};

    function renderCreateTest() {
        selectedSubtopics = {};
        const el = document.getElementById('screen-create');

        el.innerHTML = `
            <div class="create-container">
                <div class="page-header">
                    <h1>Create Test</h1>
                    <p>Select subjects, configure your test, and start practicing</p>
                </div>

                <div class="card">
                    <div class="card-title">📚 Select Subjects & Topics</div>
                    <div style="display:flex; gap:8px; margin-bottom:16px; flex-wrap:wrap">
                        <button class="btn btn-sm btn-secondary" onclick="App.selectAllTopics()">Select All</button>
                        <button class="btn btn-sm btn-ghost" onclick="App.deselectAllTopics()">Deselect All</button>
                    </div>
                    <div class="topic-selector" id="topic-selector"></div>
                    <div style="margin-top:12px; font-size:13px; color:var(--text-secondary)">
                        Selected: <strong id="selected-count">0</strong> questions available
                    </div>
                </div>

                <div class="card">
                    <div class="card-title">🎯 Question Filter</div>
                    <div class="filter-row">
                        <button class="filter-chip active" data-filter="all" onclick="App.setFilter(this,'all')">All</button>
                        <button class="filter-chip" data-filter="unused" onclick="App.setFilter(this,'unused')">Unused</button>
                        <button class="filter-chip" data-filter="incorrect" onclick="App.setFilter(this,'incorrect')">Previously Incorrect</button>
                        <button class="filter-chip" data-filter="flagged" onclick="App.setFilter(this,'flagged')">Flagged</button>
                    </div>
                </div>

                <div class="card">
                    <div class="card-title">⚙️ Test Mode</div>
                    <div class="mode-toggles">
                        <div class="mode-toggle-row">
                            <div class="mode-toggle-info">
                                <div class="mode-toggle-label">🎓 Tutor Mode</div>
                                <div class="mode-toggle-desc">See explanations after each question</div>
                            </div>
                            <label class="toggle-switch">
                                <input type="checkbox" id="toggle-tutor" checked onchange="App.toggleTutor()">
                                <span class="toggle-slider"></span>
                            </label>
                        </div>
                        <div class="mode-toggle-row">
                            <div class="mode-toggle-info">
                                <div class="mode-toggle-label">⏱️ Timed Mode</div>
                                <div class="mode-toggle-desc">90 seconds per question countdown</div>
                            </div>
                            <label class="toggle-switch">
                                <input type="checkbox" id="toggle-timed" onchange="App.toggleTimed()">
                                <span class="toggle-slider"></span>
                            </label>
                        </div>
                    </div>
                </div>

                <div class="card">
                    <div class="card-title">🔢 Number of Questions</div>
                    <div class="q-count-section">
                        <input type="number" class="q-count-input" id="q-count" value="40" min="1" max="200"
                            onchange="App.syncSlider()" oninput="App.syncSlider()">
                        <input type="range" class="q-count-slider" id="q-slider" min="1" max="200" value="40"
                            oninput="App.syncInput()">
                    </div>
                    <div style="display:flex; justify-content:space-between; font-size:12px; color:var(--text-light)">
                        <span>1</span>
                        <span id="q-max-label">Max: —</span>
                    </div>
                </div>

                <div style="text-align:center; margin-top:24px">
                    <button class="btn btn-primary btn-lg" id="start-test-btn" onclick="App.startTest()">
                        🚀 Start Test
                    </button>
                </div>
            </div>
        `;

        renderTopicSelector();
        state.isTutor = true;
        state.isTimed = false;
        state.selectedFilter = 'all';
    }

    function renderTopicSelector() {
        const container = document.getElementById('topic-selector');
        let html = '';

        for (const topic of Object.keys(topics)) {
            const subtopics = Object.keys(topics[topic]);
            const totalCount = countTopicQuestions(topic);

            html += `
                <div class="topic-group">
                    <button class="topic-group-header" onclick="App.toggleTopicGroup(this)">
                        <div class="custom-check" data-topic="${topic}" onclick="event.stopPropagation(); App.toggleTopicCheck(this, '${escapeAttr(topic)}')">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="white"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
                        </div>
                        <span>${topic}</span>
                        <span class="topic-group-count">${totalCount}</span>
                        <span class="chevron">▶</span>
                    </button>
                    <div class="topic-subtopics" data-topic="${escapeAttr(topic)}">
                        ${subtopics.map(sub => {
                            const count = topics[topic][sub].length;
                            return `
                                <div class="subtopic-item" onclick="App.toggleSubtopic('${escapeAttr(topic)}', '${escapeAttr(sub)}', this)">
                                    <div class="custom-check" data-subtopic="${escapeAttr(sub)}">
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="white"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
                                    </div>
                                    <label>${sub}</label>
                                    <span class="subtopic-count">${count}</span>
                                </div>
                            `;
                        }).join('')}
                    </div>
                </div>
            `;
        }
        container.innerHTML = html;
    }

    function escapeAttr(s) {
        return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '&quot;');
    }

    function toggleTopicGroup(header) {
        header.classList.toggle('expanded');
        const subtopicDiv = header.nextElementSibling;
        subtopicDiv.classList.toggle('open');
    }

    function toggleTopicCheck(checkEl, topicName) {
        const isChecked = checkEl.classList.contains('checked');
        const subtopics = Object.keys(topics[topicName]);

        if (isChecked) {
            checkEl.classList.remove('checked', 'partial');
            subtopics.forEach(sub => {
                delete selectedSubtopics[topicName + '::' + sub];
            });
            // Update subtopic checkboxes
            const container = document.querySelector(`.topic-subtopics[data-topic="${CSS.escape(topicName)}"]`);
            if (container) {
                container.querySelectorAll('.custom-check').forEach(c => c.classList.remove('checked'));
            }
        } else {
            checkEl.classList.add('checked');
            checkEl.classList.remove('partial');
            subtopics.forEach(sub => {
                selectedSubtopics[topicName + '::' + sub] = true;
            });
            const container = document.querySelector(`.topic-subtopics[data-topic="${CSS.escape(topicName)}"]`);
            if (container) {
                container.querySelectorAll('.custom-check').forEach(c => c.classList.add('checked'));
            }
        }
        updateSelectedCount();
    }

    function toggleSubtopic(topicName, subtopicName, itemEl) {
        const check = itemEl.querySelector('.custom-check');
        const key = topicName + '::' + subtopicName;

        if (check.classList.contains('checked')) {
            check.classList.remove('checked');
            delete selectedSubtopics[key];
        } else {
            check.classList.add('checked');
            selectedSubtopics[key] = true;
        }

        // Update parent topic checkbox
        updateParentTopicCheck(topicName);
        updateSelectedCount();
    }

    function updateParentTopicCheck(topicName) {
        const subtopics = Object.keys(topics[topicName]);
        const selectedCount = subtopics.filter(sub => selectedSubtopics[topicName + '::' + sub]).length;
        const headerCheck = document.querySelector(`.custom-check[data-topic="${CSS.escape(topicName)}"]`);
        if (!headerCheck) return;

        headerCheck.classList.remove('checked', 'partial');
        if (selectedCount === subtopics.length) {
            headerCheck.classList.add('checked');
        } else if (selectedCount > 0) {
            headerCheck.classList.add('partial', 'checked');
        }
    }

    function updateSelectedCount() {
        const ids = getSelectedQuestionIds();
        const el = document.getElementById('selected-count');
        if (el) el.textContent = ids.length;

        const slider = document.getElementById('q-slider');
        const input = document.getElementById('q-count');
        const maxLabel = document.getElementById('q-max-label');
        if (slider && input) {
            const max = Math.min(ids.length, 200);
            slider.max = max;
            input.max = max;
            if (parseInt(input.value) > max) input.value = max;
            if (maxLabel) maxLabel.textContent = `Max: ${ids.length}`;
        }
    }

    function getSelectedQuestionIds() {
        let ids = [];
        for (const key of Object.keys(selectedSubtopics)) {
            if (!selectedSubtopics[key]) continue;
            const [topicName, subtopicName] = key.split('::');
            const qs = topics[topicName]?.[subtopicName] || [];
            ids.push(...qs);
        }

        // Apply filter
        const filter = state.selectedFilter || 'all';
        if (filter === 'unused') {
            ids = ids.filter(id => !questionStatus[id]?.answered);
        } else if (filter === 'incorrect') {
            ids = ids.filter(id => questionStatus[id]?.answered && !questionStatus[id]?.correct);
        } else if (filter === 'flagged') {
            ids = ids.filter(id => questionStatus[id]?.flagged);
        }

        return [...new Set(ids)];
    }

    function selectAllTopics() {
        for (const topic of Object.keys(topics)) {
            for (const sub of Object.keys(topics[topic])) {
                selectedSubtopics[topic + '::' + sub] = true;
            }
        }
        renderTopicSelector();
        // Check all
        document.querySelectorAll('.topic-group-header .custom-check').forEach(c => c.classList.add('checked'));
        document.querySelectorAll('.subtopic-item .custom-check').forEach(c => c.classList.add('checked'));
        updateSelectedCount();
    }

    function deselectAllTopics() {
        selectedSubtopics = {};
        document.querySelectorAll('.custom-check').forEach(c => c.classList.remove('checked', 'partial'));
        updateSelectedCount();
    }

    function toggleTutor() {
        state.isTutor = document.getElementById('toggle-tutor').checked;
    }

    function toggleTimed() {
        state.isTimed = document.getElementById('toggle-timed').checked;
    }

    function setFilter(el, filter) {
        state.selectedFilter = filter;
        document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
        el.classList.add('active');
        updateSelectedCount();
    }

    function syncSlider() {
        const input = document.getElementById('q-count');
        const slider = document.getElementById('q-slider');
        if (input && slider) slider.value = input.value;
    }
    function syncInput() {
        const input = document.getElementById('q-count');
        const slider = document.getElementById('q-slider');
        if (input && slider) input.value = slider.value;
    }

    // ===== START TEST =====
    async function startTest() {
        const available = getSelectedQuestionIds();
        const count = Math.min(parseInt(document.getElementById('q-count')?.value || 40), available.length);

        if (available.length === 0) {
            alert('Please select at least one topic with available questions.');
            return;
        }

        // Shuffle and pick
        const shuffled = [...available].sort(() => Math.random() - 0.5);
        const selected = shuffled.slice(0, count);

        // Create test object
        const test = {
            id: 'test_' + Date.now(),
            date: new Date().toISOString(),
            tutor: state.isTutor,
            timed: state.isTimed,
            mode: (state.isTutor ? 'Tutor' : 'Untutored') + ' / ' + (state.isTimed ? 'Timed' : 'Untimed'),
            questionIds: selected,
            answers: {},
            submitted: {},
            flagged: {},
            startTime: Date.now(),
            completed: false,
            score: 0,
            correct: 0,
            total: selected.length,
        };

        state.currentTest = test;
        state.currentQuestionIdx = 0;
        state.questionTimers = {};
        state.navigatorOpen = false;

        // Mark questions as used
        selected.forEach(id => {
            if (!usedQuestions.includes(id)) usedQuestions.push(id);
        });
        savePersist();

        // Start timer
        if (state.isTimed) {
            state.timerSeconds = count * 90; // 90 seconds per question
        } else {
            state.timerSeconds = 0;
        }

        navigate('test');
        await renderTestScreen();
    }

    // ===== TEST SCREEN =====
    async function renderTestScreen() {
        const el = document.getElementById('screen-test');
        const test = state.currentTest;
        if (!test) return;

        el.innerHTML = `
            <div class="test-top-bar">
                <div class="test-top-left">
                    ${test.completed ? `
                        <button class="tool-btn" onclick="App.navigate('dashboard')" data-tooltip="Back">
                            <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>
                        </button>
                    ` : ''}
                    <div class="test-question-counter">
                        Question <span id="q-current-num">1</span> of ${test.total}
                    </div>
                </div>
                <div class="test-top-center">
                    <div class="test-progress-bar">
                        <div class="fill" id="test-progress-fill" style="width: ${(1/test.total)*100}%"></div>
                    </div>
                    ${test.completed ? '' : test.timed ? `<div class="test-timer timed-active" id="test-timer">${formatTime(state.timerSeconds)}</div>` :
                      `<div class="test-timer" id="test-timer" style="font-size:16px">00:00</div>`}
                </div>
                <div class="test-top-right">
                    <div class="font-size-controls">
                        <button class="font-btn" onclick="App.changeFontSize(-1)">A-</button>
                        <button class="font-btn" onclick="App.changeFontSize(1)">A+</button>
                    </div>
                    <button class="tool-btn" onclick="App.toggleHighlight()" id="highlight-btn" data-tooltip="Highlight">
                        🖊️
                    </button>
                    <button class="tool-btn" onclick="App.openLab()" data-tooltip="Lab Values">
                        🧪
                    </button>
                    <button class="tool-btn" onclick="App.openCalc()" data-tooltip="Calculator">
                        🔢
                    </button>
                    <button class="tool-btn" onclick="App.openNotes()" data-tooltip="Notes">
                        📝
                    </button>
                    <button class="tool-btn" id="flag-btn" onclick="App.toggleFlag()" data-tooltip="Flag">
                        ⚑
                    </button>
                    <button class="tool-btn" onclick="App.toggleNavigator()" data-tooltip="Navigator">
                        <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z"/></svg>
                    </button>
                </div>
            </div>

            <div class="test-body">
                <div class="question-panel" id="question-panel">
                    <div class="loading-page"><div class="loading-spinner"></div> Loading question...</div>
                </div>
            </div>

            <div class="test-bottom-bar">
                <div class="test-bottom-left">
                    <button class="btn btn-ghost btn-sm" onclick="App.prevQuestion()" id="prev-btn" disabled>
                        ← Previous
                    </button>
                </div>
                <div class="test-bottom-center">
                    <button class="btn btn-primary" onclick="App.submitAnswer()" id="submit-btn">
                        Submit
                    </button>
                </div>
                <div class="test-bottom-right">
                    <button class="btn btn-ghost btn-sm" onclick="App.nextQuestion()" id="next-btn">
                        Next →
                    </button>
                    ${!test.completed ? `
                        <div style="display:flex;gap:8px;margin-left:16px;border-left:1px solid var(--border);padding-left:16px">
                            <button class="btn-suspend" onclick="App.suspendTest()">Suspend</button>
                            <button class="btn-end-block" onclick="App.endTestConfirm()">End Block</button>
                        </div>
                    ` : ''}
                </div>
            </div>

            <div class="q-navigator-overlay" id="q-navigator-overlay" onclick="App.toggleNavigator()"></div>
            <div class="q-navigator" id="q-navigator">
                <div class="q-navigator-header">
                    <h3>Question Navigator</h3>
                    <button class="modal-close" onclick="App.toggleNavigator()">&times;</button>
                </div>
                <div class="q-navigator-body">
                    <div class="q-navigator-grid" id="q-nav-grid"></div>
                </div>
                <div class="q-navigator-legend">
                    <div class="legend-item"><div class="legend-dot" style="border-color:var(--primary);background:var(--primary-light)"></div> Current</div>
                    <div class="legend-item"><div class="legend-dot" style="border-color:#e0e0e0;background:#e8eaed"></div> Answered</div>
                    <div class="legend-item"><div class="legend-dot" style="border-color:var(--success);background:var(--success-light)"></div> Correct</div>
                    <div class="legend-item"><div class="legend-dot" style="border-color:var(--error);background:var(--error-light)"></div> Incorrect</div>
                    <div class="legend-item"><div class="legend-dot" style="border-color:var(--warning);background:var(--warning-light)"></div> Flagged</div>
                </div>
            </div>
        `;

        if (!test.completed) startTestTimer();
        await loadQuestion(0);
        updateNavigator();
    }

    async function loadQuestion(idx) {
        const test = state.currentTest;
        if (!test || idx < 0 || idx >= test.questionIds.length) return;

        state.currentQuestionIdx = idx;
        const qid = test.questionIds[idx];
        const panel = document.getElementById('question-panel');
        panel.innerHTML = '<div class="loading-page"><div class="loading-spinner"></div> Loading question...</div>';

        // Track time per question
        if (state.questionTimerStart) {
            const prevQid = test.questionIds[state.prevQuestionIdx ?? idx];
            state.questionTimers[prevQid] = (state.questionTimers[prevQid] || 0) + (Date.now() - state.questionTimerStart);
        }
        state.questionTimerStart = Date.now();
        state.prevQuestionIdx = idx;

        const q = await fetchQuestion(qid);

        if (!q) {
            panel.innerHTML = `
                <div class="empty-state">
                    <div class="empty-icon">⚠️</div>
                    <h3>Question not found</h3>
                    <p>Could not load question ${qid}. The file may be missing.</p>
                </div>
            `;
            return;
        }

        const isSubmitted = test.submitted[qid];
        const userAnswer = test.answers[qid];
        const isFlagged = test.flagged[qid];
        const isReviewUnanswered = test.completed && !isSubmitted;

        let html = `
            <div class="question-id-badge">Question ID: ${qid}</div>
            <div class="question-stem" style="font-size:${state.fontSize}px" id="question-stem">
                ${q.stem}
            </div>
            <div class="choices-container" id="choices-container">
        `;

        for (const choice of q.choices) {
            let classes = 'choice-item';
            if (isSubmitted) {
                classes += ' disabled show-stats';
                if (choice.letter === q.correctAnswer) classes += ' correct';
                else if (choice.letter === userAnswer) classes += ' incorrect';
            } else if (isReviewUnanswered) {
                classes += ' disabled';
            } else if (choice.letter === userAnswer) {
                classes += ' selected';
            }

            const pct = q.choicePercentages[choice.letter] || 0;

            html += `
                <div class="${classes}" data-letter="${choice.letter}"
                     onclick="App.selectChoice('${choice.letter}')"
                     oncontextmenu="event.preventDefault(); App.strikethroughChoice(this)">
                    <div class="choice-letter">${choice.letter}</div>
                    <div class="choice-text">${choice.text}</div>
                    <div class="choice-percent">${pct}%</div>
                    <div class="choice-bar" style="width: ${pct}%"></div>
                </div>
            `;
        }

        html += '</div>';

        // Show explanation if submitted (tutor mode or review)
        if (isSubmitted) {
            const isCorrect = userAnswer === q.correctAnswer;
            html += `
                <div class="explanation-panel">
                    <div class="explanation-header">
                        <div class="explanation-result ${isCorrect ? 'correct-result' : 'incorrect-result'}">
                            ${isCorrect ? '✓ Correct!' : `✗ Incorrect — Answer: ${q.correctAnswer}`}
                        </div>
                        <div class="explanation-stats">
                            <div><span>${q.percentCorrect}%</span> answered correctly</div>
                        </div>
                    </div>
                    <div class="explanation-content" style="font-size:${state.fontSize}px">
                        ${q.explanation}
                        ${q.explanationImages.map(src => `<img src="${src}" loading="lazy" style="max-width:100%;cursor:pointer" onclick="App.showExhibit('${src}')">`).join('')}
                    </div>
                </div>
            `;
        }

        panel.innerHTML = html;

        // Update UI
        document.getElementById('q-current-num').textContent = idx + 1;
        document.getElementById('test-progress-fill').style.width = ((idx + 1) / test.total * 100) + '%';

        const prevBtn = document.getElementById('prev-btn');
        const nextBtn = document.getElementById('next-btn');
        const submitBtn = document.getElementById('submit-btn');

        if (prevBtn) prevBtn.disabled = idx === 0;

        if (isSubmitted) {
            if (submitBtn) {
                if (idx < test.total - 1) {
                    submitBtn.textContent = 'Next →';
                    submitBtn.onclick = () => App.nextQuestion();
                } else {
                    submitBtn.textContent = 'Finish Test';
                    submitBtn.onclick = () => App.finishTest();
                    submitBtn.className = 'btn btn-success';
                }
            }
        } else {
            if (submitBtn) {
                submitBtn.textContent = 'Submit';
                submitBtn.onclick = () => App.submitAnswer();
                submitBtn.className = 'btn btn-primary';
                submitBtn.disabled = !userAnswer;
            }
        }

        // Update flag button
        const flagBtn = document.getElementById('flag-btn');
        if (flagBtn) flagBtn.classList.toggle('flagged', !!isFlagged);

        updateNavigator();
    }

    function selectChoice(letter) {
        const test = state.currentTest;
        if (test.completed) return;
        const qid = test.questionIds[state.currentQuestionIdx];
        if (test.submitted[qid]) return;

        test.answers[qid] = letter;

        // Update visual
        document.querySelectorAll('.choice-item').forEach(el => {
            el.classList.toggle('selected', el.dataset.letter === letter);
        });

        const submitBtn = document.getElementById('submit-btn');
        if (submitBtn) submitBtn.disabled = false;
    }

    function strikethroughChoice(el) {
        const test = state.currentTest;
        if (test.completed) return;
        const qid = test.questionIds[state.currentQuestionIdx];
        if (test.submitted[qid]) return;
        el.classList.toggle('strikethrough');
    }

    async function submitAnswer() {
        const test = state.currentTest;
        if (test.completed) return;
        const idx = state.currentQuestionIdx;
        const qid = test.questionIds[idx];
        const userAnswer = test.answers[qid];

        if (!userAnswer) {
            alert('Please select an answer');
            return;
        }

        if (test.submitted[qid]) return;

        const q = await fetchQuestion(qid);
        if (!q) return;

        const isCorrect = userAnswer === q.correctAnswer;
        test.submitted[qid] = true;

        // Update question status
        questionStatus[qid] = {
            answered: true,
            correct: isCorrect,
            userAnswer: userAnswer,
            flagged: test.flagged[qid] || false,
            timeSpent: state.questionTimers[qid] || 0,
            date: new Date().toISOString(),
        };

        // Update performance
        const topicInfo = getTopicForQuestion(qid);
        const perfKey = topicInfo.topic;
        if (!performance[perfKey]) performance[perfKey] = { correct: 0, total: 0 };
        performance[perfKey].total++;
        if (isCorrect) performance[perfKey].correct++;

        savePersist();

        // In tutor mode, show explanation immediately
        if (test.tutor) {
            await loadQuestion(idx);
        } else {
            // Just mark visually and move on
            document.querySelectorAll('.choice-item').forEach(el => {
                el.classList.add('disabled');
            });

            const submitBtn = document.getElementById('submit-btn');
            if (idx < test.total - 1) {
                submitBtn.textContent = 'Next →';
                submitBtn.onclick = () => App.nextQuestion();
            } else {
                submitBtn.textContent = 'Finish Test';
                submitBtn.onclick = () => App.finishTest();
                submitBtn.className = 'btn btn-success';
            }
        }

        updateNavigator();
    }

    function prevQuestion() {
        if (state.currentQuestionIdx > 0) {
            loadQuestion(state.currentQuestionIdx - 1);
        }
    }

    function nextQuestion() {
        const test = state.currentTest;
        if (state.currentQuestionIdx < test.total - 1) {
            loadQuestion(state.currentQuestionIdx + 1);
        }
    }

    function goToQuestion(idx) {
        loadQuestion(idx);
        state.navigatorOpen = false;
        document.getElementById('q-navigator')?.classList.remove('open');
    }

    function toggleFlag() {
        const test = state.currentTest;
        const qid = test.questionIds[state.currentQuestionIdx];
        test.flagged[qid] = !test.flagged[qid];
        if (questionStatus[qid]) questionStatus[qid].flagged = test.flagged[qid];
        savePersist();

        const flagBtn = document.getElementById('flag-btn');
        if (flagBtn) flagBtn.classList.toggle('flagged', test.flagged[qid]);
        updateNavigator();
    }

    function toggleNavigator() {
        state.navigatorOpen = !state.navigatorOpen;
        document.getElementById('q-navigator')?.classList.toggle('open', state.navigatorOpen);
        document.getElementById('q-navigator-overlay')?.classList.toggle('open', state.navigatorOpen);
    }

    function updateNavigator() {
        const grid = document.getElementById('q-nav-grid');
        const test = state.currentTest;
        if (!grid || !test) return;

        // Only show correct/incorrect in tutor mode or after test is completed
        const showResults = test.tutor || test.completed;

        grid.innerHTML = test.questionIds.map((qid, i) => {
            let cls = 'q-nav-item';
            if (i === state.currentQuestionIdx) cls += ' current';
            if (test.submitted[qid]) {
                if (showResults) {
                    const isCorrect = questionStatus[qid]?.correct;
                    cls += isCorrect ? ' correct-nav' : ' incorrect-nav';
                } else {
                    cls += ' answered';
                }
            } else if (test.answers[qid]) {
                cls += ' answered';
            }
            if (test.flagged[qid]) cls += ' flagged-nav';
            return `<button class="${cls}" onclick="App.goToQuestion(${i})">${i + 1}</button>`;
        }).join('');
    }

    // ===== TIMER =====
    function startTestTimer() {
        if (state.timerInterval) clearInterval(state.timerInterval);

        const test = state.currentTest;
        if (test.timed) {
            state.timerInterval = setInterval(() => {
                state.timerSeconds--;
                updateTimerDisplay();
                if (state.timerSeconds <= 0) {
                    clearInterval(state.timerInterval);
                    finishTest();
                }
            }, 1000);
        } else {
            // Count up — only reset if not resumed
            if (!state.timerSeconds) state.timerSeconds = 0;
            state.timerInterval = setInterval(() => {
                state.timerSeconds++;
                updateTimerDisplay();
            }, 1000);
        }
    }

    function updateTimerDisplay() {
        const el = document.getElementById('test-timer');
        if (!el) return;
        el.textContent = formatTime(state.timerSeconds);

        if (state.currentTest?.timed) {
            el.classList.toggle('warning', state.timerSeconds < 300 && state.timerSeconds > 60);
            el.classList.toggle('danger', state.timerSeconds <= 60);
        }
    }

    function formatTime(s) {
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const sec = s % 60;
        if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
        return `${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
    }

    // ===== SUSPEND TEST =====
    function suspendTest() {
        const test = state.currentTest;
        const answered = Object.keys(test.submitted).length;

        const overlay = document.createElement('div');
        overlay.className = 'confirm-overlay';
        overlay.innerHTML = `
            <div class="confirm-box">
                <h3>Suspend Test?</h3>
                <p>Your progress (${answered}/${test.total} answered) will be saved. You can resume this test from Previous Tests.</p>
                <div class="btn-row">
                    <button class="btn btn-ghost" onclick="this.closest('.confirm-overlay').remove()">Cancel</button>
                    <button class="btn btn-suspend" onclick="this.closest('.confirm-overlay').remove(); App.doSuspend()">Suspend</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);
    }

    function doSuspend() {
        if (state.timerInterval) clearInterval(state.timerInterval);

        const test = state.currentTest;

        // Track time for current question
        if (state.questionTimerStart) {
            const qid = test.questionIds[state.currentQuestionIdx];
            state.questionTimers[qid] = (state.questionTimers[qid] || 0) + (Date.now() - state.questionTimerStart);
        }

        // Save suspended test to history
        const suspendedTest = {
            id: test.id,
            date: test.date,
            mode: test.mode,
            tutor: test.tutor,
            timed: test.timed,
            score: 0,
            correct: 0,
            answered: Object.keys(test.submitted).length,
            total: test.total,
            questionIds: test.questionIds,
            answers: { ...test.answers },
            submitted: { ...test.submitted },
            flagged: { ...test.flagged },
            totalTime: state.timerSeconds,
            suspended: true,
            completed: false,
            currentIdx: state.currentQuestionIdx,
            questionTimers: { ...state.questionTimers },
            remainingTime: state.timerSeconds,
        };

        // Check if already in history (resumed test) — update it
        const existingIdx = testHistory.findIndex(t => t.id === test.id);
        if (existingIdx >= 0) {
            testHistory[existingIdx] = suspendedTest;
        } else {
            testHistory.push(suspendedTest);
        }
        savePersist();

        state.currentTest = null;
        navigate('previous');
    }

    // ===== FINISH TEST =====
    function endTestConfirm() {
        const test = state.currentTest;
        const answered = Object.keys(test.submitted).length;

        if (answered < test.total) {
            const overlay = document.createElement('div');
            overlay.className = 'confirm-overlay';
            overlay.innerHTML = `
                <div class="confirm-box">
                    <h3>End Test?</h3>
                    <p>You have answered ${answered} of ${test.total} questions. Your score will be calculated based on the ${answered} answered question${answered !== 1 ? 's' : ''} only. Unanswered questions will not be scored.</p>
                    <div class="btn-row">
                        <button class="btn btn-ghost" onclick="this.closest('.confirm-overlay').remove()">Cancel</button>
                        <button class="btn btn-danger" onclick="this.closest('.confirm-overlay').remove(); App.finishTest()">End Test</button>
                    </div>
                </div>
            `;
            document.body.appendChild(overlay);
        } else {
            finishTest();
        }
    }

    function finishTest() {
        try {
            if (state.timerInterval) { clearInterval(state.timerInterval); state.timerInterval = null; }

            const test = state.currentTest;
            if (!test) { navigate('dashboard'); return; }

            // Track time for current question
            if (state.questionTimerStart) {
                const qid = test.questionIds[state.currentQuestionIdx];
                state.questionTimers[qid] = (state.questionTimers[qid] || 0) + (Date.now() - state.questionTimerStart);
                state.questionTimerStart = null;
            }

            // Calculate score based on answered questions only
            const answeredIds = test.questionIds.filter(qid => test.submitted[qid]);
            let correct = 0;
            answeredIds.forEach(qid => {
                if (questionStatus[qid]?.correct) correct++;
            });
            test.answered = answeredIds.length;
            test.correct = correct;
            test.score = test.answered > 0 ? Math.round((correct / test.answered) * 100) : 0;
            test.completed = true;
            test.endTime = Date.now();
            test.totalTime = state.timerSeconds;

            // Save to history — replace if already exists (was suspended), otherwise push
            const completedEntry = {
                id: test.id,
                date: test.date,
                mode: test.mode,
                tutor: test.tutor,
                timed: test.timed,
                score: test.score,
                correct: test.correct,
                answered: test.answered,
                total: test.total,
                questionIds: test.questionIds,
                answers: test.answers,
                submitted: { ...test.submitted },
                flagged: { ...test.flagged },
                totalTime: test.totalTime,
                completed: true,
                suspended: false,
            };
            const existingIdx = testHistory.findIndex(t => t.id === test.id);
            if (existingIdx >= 0) {
                testHistory[existingIdx] = completedEntry;
            } else {
                testHistory.push(completedEntry);
            }
            savePersist();

            renderResults();
        } catch (err) {
            console.error('finishTest error:', err);
            alert('Error finishing test: ' + err.message);
        }
    }

    // ===== RESULTS =====
    function renderResults() {
        const test = state.currentTest;
        navigate('results');
        const el = document.getElementById('screen-results');

        const answered = test.answered || Object.keys(test.submitted).length;
        const incorrect = answered - test.correct;
        const omitted = test.total - answered;
        const totalTimeSec = test.timed
            ? Math.round((test.endTime - Date.parse(test.date)) / 1000)
            : state.timerSeconds;
        const avgTime = answered > 0 ? Math.round(totalTimeSec / answered) : 0;

        el.innerHTML = `
            <div class="results-container">
                <div class="results-header">
                    <div class="results-score">${test.score}%</div>
                    <div class="results-subtitle">
                        You scored ${test.correct} out of ${answered} answered (${test.total} total) — ${test.mode}
                    </div>
                </div>

                <div class="results-summary-grid">
                    <div class="result-stat-card green">
                        <div class="val">${test.correct}</div>
                        <div class="lbl">Correct</div>
                    </div>
                    <div class="result-stat-card red">
                        <div class="val">${incorrect}</div>
                        <div class="lbl">Incorrect</div>
                    </div>
                    <div class="result-stat-card" style="border-left:4px solid var(--text-light)">
                        <div class="val">${omitted}</div>
                        <div class="lbl">Omitted</div>
                    </div>
                    <div class="result-stat-card blue">
                        <div class="val">${formatTime(totalTimeSec)}</div>
                        <div class="lbl">Total Time (avg ${avgTime}s/q)</div>
                    </div>
                </div>

                <div class="card" style="margin-top:24px">
                    <div class="card-title">📋 Question Review</div>
                    <div class="tabs">
                        <button class="tab active" onclick="App.filterResults('all', this)">All (${test.total})</button>
                        <button class="tab" onclick="App.filterResults('correct', this)">Correct (${test.correct})</button>
                        <button class="tab" onclick="App.filterResults('incorrect', this)">Incorrect (${incorrect})</button>
                        <button class="tab" onclick="App.filterResults('omitted', this)">Omitted (${omitted})</button>
                        <button class="tab" onclick="App.filterResults('flagged', this)">Flagged</button>
                    </div>
                    <div class="results-question-list" id="results-q-list"></div>
                </div>

                <div style="text-align:center; margin-top:24px; display:flex; gap:12px; justify-content:center">
                    <button class="btn btn-primary" onclick="App.reviewTestQuestions()">Review Questions</button>
                    <button class="btn btn-secondary" onclick="App.navigate('create')">New Test</button>
                    <button class="btn btn-ghost" onclick="App.navigate('dashboard')">Dashboard</button>
                </div>
            </div>
        `;

        filterResults('all');
    }

    function filterResults(filter, tabEl) {
        if (tabEl) {
            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            tabEl.classList.add('active');
        }

        const test = state.currentTest;
        const list = document.getElementById('results-q-list');
        if (!list) return;

        let items = test.questionIds.map((qid, i) => ({ qid, idx: i }));

        if (filter === 'correct') items = items.filter(x => questionStatus[x.qid]?.correct);
        else if (filter === 'incorrect') items = items.filter(x => questionStatus[x.qid]?.answered && !questionStatus[x.qid]?.correct);
        else if (filter === 'omitted') items = items.filter(x => !test.submitted[x.qid]);
        else if (filter === 'flagged') items = items.filter(x => test.flagged[x.qid]);

        list.innerHTML = items.map(({ qid, idx }) => {
            const qs = questionStatus[qid];
            const answered = qs?.answered;
            const correct = qs?.correct;
            const info = getTopicForQuestion(qid);
            const timeSec = Math.round((state.questionTimers[qid] || 0) / 1000);

            return `
                <div class="results-q-item" onclick="App.reviewQuestion(${idx})">
                    <div class="results-q-icon ${correct ? 'correct-icon' : answered ? 'incorrect-icon' : 'skipped-icon'}">
                        ${correct ? '✓' : answered ? '✗' : '—'}
                    </div>
                    <div class="results-q-info">
                        <div class="q-num">Question ${idx + 1} (ID: ${qid})</div>
                        <div class="q-topic">${info.topic} → ${info.subtopic}</div>
                    </div>
                    <div class="results-q-answer" style="color: ${correct ? 'var(--success)' : answered ? 'var(--error)' : 'var(--text-light)'}">
                        ${qs?.userAnswer ? `Answered: ${qs.userAnswer}` : 'Not Answered'}
                    </div>
                    <div class="results-q-time">${timeSec}s</div>
                </div>
            `;
        }).join('');

        if (items.length === 0) {
            list.innerHTML = '<div class="empty-state" style="padding:24px"><p>No questions match this filter</p></div>';
        }
    }

    function reviewTestQuestions() {
        state.currentQuestionIdx = 0;
        // Only mark answered questions as submitted for review
        // Unanswered questions remain unsubmitted (shown blank in review)
        navigate('test');
        renderTestScreen();
    }

    async function reviewQuestion(idx) {
        state.currentQuestionIdx = idx;
        navigate('test');
        await renderTestScreen();
        loadQuestion(idx);
    }

    function reviewTest(testId) {
        const hist = testHistory.find(t => t.id === testId);
        if (!hist) return;

        state.currentTest = {
            ...hist,
            submitted: hist.submitted ? { ...hist.submitted } : {},
            flagged: hist.flagged ? { ...hist.flagged } : {},
            completed: true,
        };
        // Only mark answered questions as submitted for review
        if (!hist.submitted) {
            hist.questionIds.forEach(qid => {
                if (hist.answers && hist.answers[qid]) {
                    state.currentTest.submitted[qid] = true;
                }
            });
        }

        state.currentQuestionIdx = 0;
        navigate('test');
        renderTestScreen();
    }

    async function resumeTest(testId) {
        const hist = testHistory.find(t => t.id === testId);
        if (!hist || !hist.suspended) return;

        // Restore test state
        state.currentTest = {
            ...hist,
            answers: hist.answers ? { ...hist.answers } : {},
            submitted: hist.submitted ? { ...hist.submitted } : {},
            flagged: hist.flagged ? { ...hist.flagged } : {},
            completed: false,
            suspended: false,
        };

        state.currentQuestionIdx = hist.currentIdx || 0;
        state.questionTimers = hist.questionTimers ? { ...hist.questionTimers } : {};
        state.navigatorOpen = false;

        // Restore timer
        if (hist.timed) {
            state.timerSeconds = hist.remainingTime || 0;
        } else {
            state.timerSeconds = hist.totalTime || 0;
        }

        navigate('test');
        await renderTestScreen();
    }

    // ===== PERFORMANCE =====
    function renderPerformance() {
        const el = document.getElementById('screen-performance');

        const totalAnswered = Object.keys(questionStatus).filter(k => questionStatus[k].answered).length;
        const totalCorrect = Object.keys(questionStatus).filter(k => questionStatus[k].correct).length;
        const overallPct = totalAnswered > 0 ? Math.round((totalCorrect / totalAnswered) * 100) : 0;

        el.innerHTML = `
            <div class="page-header">
                <h1>Performance Analytics</h1>
                <p>Track your progress across all subjects</p>
            </div>

            <div class="stats-row" style="grid-template-columns: repeat(3, 1fr)">
                <div class="stat-card">
                    <div class="stat-label">Questions Answered</div>
                    <div class="stat-value">${totalAnswered}</div>
                </div>
                <div class="stat-card">
                    <div class="stat-label">Overall Accuracy</div>
                    <div class="stat-value">${overallPct}%</div>
                </div>
                <div class="stat-card">
                    <div class="stat-label">Tests Completed</div>
                    <div class="stat-value">${testHistory.length}</div>
                </div>
            </div>

            <div class="card">
                <div class="card-title">📊 Performance by Subject</div>
                <div id="perf-bars-full"></div>
            </div>

            <div class="card" style="margin-top:20px">
                <div class="card-title">📋 Detailed Breakdown</div>
                <table class="topic-perf-table">
                    <thead>
                        <tr>
                            <th>Subject</th>
                            <th>Subtopic</th>
                            <th>Answered</th>
                            <th>Correct</th>
                            <th>Accuracy</th>
                        </tr>
                    </thead>
                    <tbody id="perf-detail-table"></tbody>
                </table>
            </div>

            <div style="text-align:center; margin-top:24px">
                <button class="btn btn-danger btn-sm" onclick="App.resetProgress()">Reset All Progress</button>
            </div>
        `;

        renderPerfBars('perf-bars-full');
        renderPerfDetailTable();
    }

    function renderPerfDetailTable() {
        const tbody = document.getElementById('perf-detail-table');
        if (!tbody) return;

        let rows = '';
        for (const topic of Object.keys(topics)) {
            for (const sub of Object.keys(topics[topic])) {
                const qIds = topics[topic][sub];
                const answered = qIds.filter(id => questionStatus[id]?.answered).length;
                if (answered === 0) continue;
                const correct = qIds.filter(id => questionStatus[id]?.correct).length;
                const pct = Math.round((correct / answered) * 100);
                const color = pct >= 70 ? 'var(--success)' : pct >= 50 ? 'var(--warning)' : 'var(--error)';

                rows += `
                    <tr>
                        <td>${topic}</td>
                        <td>${sub}</td>
                        <td>${answered}/${qIds.length}</td>
                        <td>${correct}</td>
                        <td style="font-weight:700;color:${color}">${pct}%</td>
                    </tr>
                `;
            }
        }

        tbody.innerHTML = rows || '<tr><td colspan="5" style="text-align:center;padding:24px;color:var(--text-light)">No data yet</td></tr>';
    }

    function resetProgress() {
        if (confirm('Are you sure you want to reset ALL progress? This cannot be undone.')) {
            testHistory = [];
            performance = {};
            questionStatus = {};
            notes = {};
            usedQuestions = [];
            savePersist();
            navigate('dashboard');
        }
    }

    // ===== SEARCH =====
    function renderSearch() {
        const el = document.getElementById('screen-search');

        el.innerHTML = `
            <div class="page-header">
                <h1>Search Questions</h1>
                <p>Browse and search through all ${allIds.length} questions</p>
            </div>

            <div class="search-bar">
                <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>
                <input type="text" placeholder="Search by question ID, topic, or keyword..." id="search-input" oninput="App.doSearch()">
            </div>

            <div class="filter-row" style="margin-bottom:20px">
                <button class="filter-chip active" onclick="App.searchFilter(this, 'all')">All</button>
                <button class="filter-chip" onclick="App.searchFilter(this, 'unused')">Unused</button>
                <button class="filter-chip" onclick="App.searchFilter(this, 'correct')">Correct</button>
                <button class="filter-chip" onclick="App.searchFilter(this, 'incorrect')">Incorrect</button>
                <button class="filter-chip" onclick="App.searchFilter(this, 'flagged')">Flagged</button>
            </div>

            <div class="card">
                <div class="card-title">Browse by Topic</div>
                <div id="search-topic-browse"></div>
            </div>

            <div class="card" style="margin-top:16px;display:none" id="search-results-card">
                <div class="card-title">Search Results <span id="search-count" class="badge badge-blue"></span></div>
                <div class="search-results-list" id="search-results"></div>
            </div>
        `;

        state.searchFilterMode = 'all';
        renderSearchTopicBrowse();
    }

    function renderSearchTopicBrowse() {
        const container = document.getElementById('search-topic-browse');
        if (!container) return;

        container.innerHTML = Object.keys(topics).map(topic => {
            const count = countTopicQuestions(topic);
            const answered = Object.keys(topics[topic]).reduce((sum, sub) => {
                return sum + topics[topic][sub].filter(id => questionStatus[id]?.answered).length;
            }, 0);
            return `
                <div class="perf-bar-row" style="cursor:pointer" onclick="App.searchByTopic('${escapeAttr(topic)}')">
                    <div class="perf-bar-label">${topic}</div>
                    <div class="perf-bar-track">
                        <div class="perf-bar-fill good" style="width:${Math.round((answered/count)*100)}%"></div>
                    </div>
                    <div class="perf-bar-value">${answered}/${count}</div>
                </div>
            `;
        }).join('');
    }

    let searchTimeout;
    function doSearch() {
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(() => {
            const query = document.getElementById('search-input')?.value.trim().toLowerCase();
            if (!query) {
                document.getElementById('search-results-card').style.display = 'none';
                return;
            }

            let results = [];

            // Search by ID
            if (/^\d+$/.test(query)) {
                const match = allIds.filter(id => String(id).includes(query));
                results = match.map(id => ({ id, ...getTopicForQuestion(id) }));
            } else {
                // Search by topic name
                for (const topic of Object.keys(topics)) {
                    for (const sub of Object.keys(topics[topic])) {
                        if (topic.toLowerCase().includes(query) || sub.toLowerCase().includes(query)) {
                            topics[topic][sub].forEach(id => {
                                results.push({ id, topic, subtopic: sub });
                            });
                        }
                    }
                }
            }

            // Apply filter
            if (state.searchFilterMode === 'unused') results = results.filter(r => !questionStatus[r.id]?.answered);
            else if (state.searchFilterMode === 'correct') results = results.filter(r => questionStatus[r.id]?.correct);
            else if (state.searchFilterMode === 'incorrect') results = results.filter(r => questionStatus[r.id]?.answered && !questionStatus[r.id]?.correct);
            else if (state.searchFilterMode === 'flagged') results = results.filter(r => questionStatus[r.id]?.flagged);

            results = results.slice(0, 100);

            const card = document.getElementById('search-results-card');
            const list = document.getElementById('search-results');
            const count = document.getElementById('search-count');
            card.style.display = 'block';
            count.textContent = results.length + (results.length === 100 ? '+' : '');

            list.innerHTML = results.map(r => {
                const qs = questionStatus[r.id];
                const statusBadge = qs?.correct ? '<span class="badge badge-green">✓</span>' :
                    qs?.answered ? '<span class="badge badge-red">✗</span>' :
                    '<span class="badge badge-blue">New</span>';

                return `
                    <div class="search-result-item" onclick="App.previewQuestion(${r.id})">
                        <div style="display:flex;align-items:center;gap:12px">
                            ${statusBadge}
                            <strong>Q${r.id}</strong>
                            <span style="color:var(--text-secondary);font-size:13px">${r.topic} → ${r.subtopic}</span>
                        </div>
                    </div>
                `;
            }).join('');
        }, 300);
    }

    function searchFilter(el, mode) {
        state.searchFilterMode = mode;
        document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
        el.classList.add('active');
        doSearch();
    }

    function searchByTopic(topicName) {
        document.getElementById('search-input').value = topicName;
        doSearch();
    }

    async function previewQuestion(qid) {
        // Create a quick test with just this question for preview
        state.currentTest = {
            id: 'preview_' + Date.now(),
            date: new Date().toISOString(),
            mode: 'tutor',
            questionIds: [qid],
            answers: {},
            submitted: {},
            flagged: {},
            total: 1,
            completed: false,
        };

        // If already answered, show as submitted
        if (questionStatus[qid]?.answered) {
            state.currentTest.answers[qid] = questionStatus[qid].userAnswer;
            state.currentTest.submitted[qid] = true;
        }

        state.currentQuestionIdx = 0;
        navigate('test');
        await renderTestScreen();
    }

    // ===== PREVIOUS TESTS =====
    function renderPreviousTests() {
        const el = document.getElementById('screen-previous');

        el.innerHTML = `
            <div class="page-header">
                <h1>Previous Tests</h1>
                <p>Review your past test attempts</p>
            </div>
            <div id="prev-tests-list"></div>
        `;

        const list = document.getElementById('prev-tests-list');
        const tests = [...testHistory].reverse();

        if (tests.length === 0) {
            list.innerHTML = `
                <div class="empty-state">
                    <div class="empty-icon">📋</div>
                    <h3>No tests yet</h3>
                    <p>Complete a test to see it here</p>
                </div>
            `;
            return;
        }

        list.innerHTML = tests.map(t => {
            if (t.suspended) {
                const answeredCount = t.answers ? t.answers.filter(a => a !== null && a !== undefined).length : 0;
                return `
                <div class="test-history-item suspended-item">
                    <div class="test-history-score" style="background:var(--warning-light);color:var(--warning)">
                        <i class="fas fa-pause"></i>
                    </div>
                    <div class="test-history-info">
                        <div class="th-title">${answeredCount}/${t.total} answered — ${t.mode}
                            <span class="th-status-badge suspended">SUSPENDED</span>
                        </div>
                        <div class="th-meta">${new Date(t.date).toLocaleString()} · ${t.total} questions</div>
                    </div>
                    <div class="test-history-actions">
                        <button class="btn btn-sm" style="background:var(--primary);color:#fff;" onclick="event.stopPropagation(); App.resumeTest('${t.id}')">Resume</button>
                    </div>
                </div>
                `;
            }
            const color = t.score >= 70 ? 'var(--success)' : t.score >= 50 ? 'var(--warning)' : 'var(--error)';
            const bg = t.score >= 70 ? 'var(--success-light)' : t.score >= 50 ? 'var(--warning-light)' : 'var(--error-light)';
            return `
                <div class="test-history-item" onclick="App.reviewTest('${t.id}')">
                    <div class="test-history-score" style="background:${bg};color:${color}">
                        ${t.score}%
                    </div>
                    <div class="test-history-info">
                        <div class="th-title">${t.correct}/${t.answered || t.total} correct — ${t.mode}
                            <span class="th-status-badge completed">COMPLETED</span>
                        </div>
                        <div class="th-meta">${new Date(t.date).toLocaleString()} · ${t.total} questions</div>
                    </div>
                    <div class="test-history-actions">
                        <button class="btn btn-sm btn-secondary" onclick="event.stopPropagation(); App.reviewTest('${t.id}')">Review</button>
                    </div>
                </div>
            `;
        }).join('');
    }

    // ===== NOTEBOOK =====
    function renderNotebook() {
        const el = document.getElementById('screen-notebook');

        const notesList = Object.keys(notes).filter(k => notes[k]).sort((a, b) => b - a);

        el.innerHTML = `
            <div class="page-header">
                <h1>Notebook</h1>
                <p>Your personal notes for each question</p>
            </div>

            ${notesList.length === 0 ? `
                <div class="empty-state">
                    <div class="empty-icon">📝</div>
                    <h3>No notes yet</h3>
                    <p>Add notes while reviewing questions using the 📝 button</p>
                </div>
            ` : notesList.map(qid => {
                const topicInfo = getTopicForQuestion(parseInt(qid));
                return `
                    <div class="notebook-card" onclick="App.previewQuestion(${qid})">
                        <div class="nb-qid">Question ${qid} — ${topicInfo.topic}</div>
                        <div class="nb-text">${notes[qid]}</div>
                    </div>
                `;
            }).join('')}
        `;
    }

    // ===== TOOLS =====

    // Font size
    function changeFontSize(delta) {
        state.fontSize = Math.max(12, Math.min(24, state.fontSize + delta));
        const stem = document.getElementById('question-stem');
        if (stem) stem.style.fontSize = state.fontSize + 'px';
        document.querySelectorAll('.explanation-content').forEach(el => {
            el.style.fontSize = state.fontSize + 'px';
        });
    }

    // Highlight
    function toggleHighlight() {
        state.highlightMode = !state.highlightMode;
        document.getElementById('highlight-btn')?.classList.toggle('active', state.highlightMode);
        document.getElementById('question-panel')?.classList.toggle('highlighter-mode-active', state.highlightMode);

        if (state.highlightMode) {
            document.addEventListener('mouseup', handleHighlight);
        } else {
            document.removeEventListener('mouseup', handleHighlight);
        }
    }

    function handleHighlight() {
        if (!state.highlightMode) return;
        const sel = window.getSelection();
        if (sel.rangeCount > 0 && sel.toString().trim()) {
            const range = sel.getRangeAt(0);
            const panel = document.getElementById('question-panel');
            if (!panel?.contains(range.commonAncestorContainer)) return;

            // Check if already highlighted
            const parent = range.commonAncestorContainer.parentElement;
            if (parent?.classList?.contains('text-highlighted')) {
                const text = document.createTextNode(parent.textContent);
                parent.replaceWith(text);
            } else {
                const span = document.createElement('span');
                span.className = 'text-highlighted';
                range.surroundContents(span);
            }
            sel.removeAllRanges();
        }
    }

    // Lab values
    function openLab() {
        document.getElementById('lab-modal').style.display = 'flex';
        document.getElementById('lab-body').innerHTML = labValuesHTML;
    }
    function closeLab() {
        document.getElementById('lab-modal').style.display = 'none';
    }

    // Calculator
    function openCalc() {
        document.getElementById('calc-modal').style.display = 'flex';
        state.calcValue = '';
        document.getElementById('calc-display').value = '';
    }
    function closeCalc() {
        document.getElementById('calc-modal').style.display = 'none';
    }
    function calcInput(val) {
        state.calcValue += val;
        document.getElementById('calc-display').value = state.calcValue;
    }
    function calcEval() {
        try {
            state.calcValue = String(eval(state.calcValue));
            document.getElementById('calc-display').value = state.calcValue;
        } catch {
            document.getElementById('calc-display').value = 'Error';
            state.calcValue = '';
        }
    }
    function calcClear() {
        state.calcValue = '';
        document.getElementById('calc-display').value = '';
    }

    // Notes
    function openNotes() {
        const test = state.currentTest;
        if (!test) return;
        const qid = test.questionIds[state.currentQuestionIdx];
        document.getElementById('notes-modal').style.display = 'flex';
        document.getElementById('notes-qid').textContent = qid;
        document.getElementById('notes-textarea').value = notes[qid] || '';
    }
    function closeNotes() {
        document.getElementById('notes-modal').style.display = 'none';
    }
    function saveNote() {
        const test = state.currentTest;
        if (!test) return;
        const qid = test.questionIds[state.currentQuestionIdx];
        notes[qid] = document.getElementById('notes-textarea').value;
        savePersist();
        closeNotes();
    }

    // Exhibit viewer
    function showExhibit(src) {
        let scale = 1;
        const overlay = document.createElement('div');
        overlay.className = 'exhibit-overlay';
        overlay.innerHTML = `
            <img src="${src}" id="exhibit-img" style="transform: scale(1)">
            <div class="exhibit-controls">
                <button id="exhibit-zoomin">Zoom In</button>
                <button id="exhibit-zoomout">Zoom Out</button>
                <button id="exhibit-reset">Reset</button>
                <button id="exhibit-close">Close</button>
            </div>
        `;
        overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
        document.body.appendChild(overlay);

        const img = document.getElementById('exhibit-img');
        document.getElementById('exhibit-zoomin').onclick = () => { scale += 0.2; img.style.transform = `scale(${scale})`; };
        document.getElementById('exhibit-zoomout').onclick = () => { scale = Math.max(0.3, scale - 0.2); img.style.transform = `scale(${scale})`; };
        document.getElementById('exhibit-reset').onclick = () => { scale = 1; img.style.transform = 'scale(1)'; };
        document.getElementById('exhibit-close').onclick = () => overlay.remove();
    }

    // ===== KEYBOARD SHORTCUTS =====
    document.addEventListener('keydown', (e) => {
        if (!state.currentTest) return;

        // Number keys for answer selection
        if (e.key >= '1' && e.key <= '5') {
            const letters = ['A', 'B', 'C', 'D', 'E'];
            selectChoice(letters[parseInt(e.key) - 1]);
            return;
        }

        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            const submitBtn = document.getElementById('submit-btn');
            if (submitBtn) submitBtn.click();
        }
        if (e.key === 'ArrowRight') nextQuestion();
        if (e.key === 'ArrowLeft') prevQuestion();
        if (e.key === 'f' || e.key === 'F') toggleFlag();
    });

    // ===== LAB VALUES =====
    const labValuesHTML = `
        <div class="lab-section">
            <h3>Serum Chemistry</h3>
            <table>
                <tr><td>Sodium (Na⁺)</td><td>136-145 mEq/L</td></tr>
                <tr><td>Potassium (K⁺)</td><td>3.5-5.0 mEq/L</td></tr>
                <tr><td>Chloride (Cl⁻)</td><td>98-106 mEq/L</td></tr>
                <tr><td>Bicarbonate (HCO₃⁻)</td><td>22-28 mEq/L</td></tr>
                <tr><td>Blood urea nitrogen (BUN)</td><td>7-20 mg/dL</td></tr>
                <tr><td>Creatinine</td><td>0.7-1.3 mg/dL</td></tr>
                <tr><td>Glucose (fasting)</td><td>70-100 mg/dL</td></tr>
                <tr><td>Calcium (Ca²⁺)</td><td>8.5-10.5 mg/dL</td></tr>
                <tr><td>Phosphorus</td><td>2.5-4.5 mg/dL</td></tr>
                <tr><td>Magnesium (Mg²⁺)</td><td>1.5-2.5 mg/dL</td></tr>
                <tr><td>Uric acid</td><td>3.0-8.2 mg/dL</td></tr>
                <tr><td>Total protein</td><td>6.0-8.3 g/dL</td></tr>
                <tr><td>Albumin</td><td>3.5-5.0 g/dL</td></tr>
                <tr><td>Bilirubin, total</td><td>0.1-1.2 mg/dL</td></tr>
                <tr><td>Bilirubin, direct</td><td>0.0-0.3 mg/dL</td></tr>
                <tr><td>AST (SGOT)</td><td>10-40 U/L</td></tr>
                <tr><td>ALT (SGPT)</td><td>7-56 U/L</td></tr>
                <tr><td>Alkaline phosphatase</td><td>44-147 U/L</td></tr>
                <tr><td>GGT</td><td>9-48 U/L</td></tr>
                <tr><td>Amylase</td><td>30-110 U/L</td></tr>
                <tr><td>Lipase</td><td>0-160 U/L</td></tr>
                <tr><td>LDH</td><td>140-280 U/L</td></tr>
                <tr><td>Creatine kinase (CK)</td><td>30-200 U/L</td></tr>
                <tr><td>Osmolality</td><td>275-295 mOsm/kg</td></tr>
                <tr><td>Iron</td><td>60-170 μg/dL</td></tr>
                <tr><td>TIBC</td><td>250-370 μg/dL</td></tr>
                <tr><td>Ferritin</td><td>12-300 ng/mL</td></tr>
                <tr><td>Transferrin saturation</td><td>20-50%</td></tr>
            </table>
        </div>
        <div class="lab-section">
            <h3>Hematology</h3>
            <table>
                <tr><td>WBC</td><td>4,500-11,000/μL</td></tr>
                <tr><td>RBC (male)</td><td>4.5-5.5 million/μL</td></tr>
                <tr><td>RBC (female)</td><td>4.0-5.0 million/μL</td></tr>
                <tr><td>Hemoglobin (male)</td><td>13.5-17.5 g/dL</td></tr>
                <tr><td>Hemoglobin (female)</td><td>12.0-16.0 g/dL</td></tr>
                <tr><td>Hematocrit (male)</td><td>38-50%</td></tr>
                <tr><td>Hematocrit (female)</td><td>36-44%</td></tr>
                <tr><td>MCV</td><td>80-100 fL</td></tr>
                <tr><td>MCH</td><td>27-33 pg</td></tr>
                <tr><td>MCHC</td><td>31-37 g/dL</td></tr>
                <tr><td>RDW</td><td>11.5-14.5%</td></tr>
                <tr><td>Platelets</td><td>150,000-400,000/μL</td></tr>
                <tr><td>Reticulocyte count</td><td>0.5-2.5%</td></tr>
                <tr><td>ESR (male)</td><td>0-15 mm/hr</td></tr>
                <tr><td>ESR (female)</td><td>0-20 mm/hr</td></tr>
            </table>
        </div>
        <div class="lab-section">
            <h3>Coagulation</h3>
            <table>
                <tr><td>PT</td><td>11-15 seconds</td></tr>
                <tr><td>INR</td><td>0.8-1.2</td></tr>
                <tr><td>aPTT</td><td>25-35 seconds</td></tr>
                <tr><td>Bleeding time</td><td>2-7 minutes</td></tr>
                <tr><td>Thrombin time</td><td>14-19 seconds</td></tr>
                <tr><td>Fibrinogen</td><td>200-400 mg/dL</td></tr>
                <tr><td>D-dimer</td><td><0.5 μg/mL</td></tr>
            </table>
        </div>
        <div class="lab-section">
            <h3>Lipid Panel</h3>
            <table>
                <tr><td>Total cholesterol</td><td><200 mg/dL (desirable)</td></tr>
                <tr><td>LDL</td><td><100 mg/dL (optimal)</td></tr>
                <tr><td>HDL</td><td>>40 mg/dL (male), >50 mg/dL (female)</td></tr>
                <tr><td>Triglycerides</td><td><150 mg/dL</td></tr>
            </table>
        </div>
        <div class="lab-section">
            <h3>Arterial Blood Gas</h3>
            <table>
                <tr><td>pH</td><td>7.35-7.45</td></tr>
                <tr><td>PaO₂</td><td>80-100 mmHg</td></tr>
                <tr><td>PaCO₂</td><td>35-45 mmHg</td></tr>
                <tr><td>HCO₃⁻</td><td>22-28 mEq/L</td></tr>
                <tr><td>O₂ saturation</td><td>95-100%</td></tr>
            </table>
        </div>
        <div class="lab-section">
            <h3>Endocrine</h3>
            <table>
                <tr><td>TSH</td><td>0.5-5.0 μU/mL</td></tr>
                <tr><td>Free T4</td><td>0.7-1.9 ng/dL</td></tr>
                <tr><td>T3</td><td>80-200 ng/dL</td></tr>
                <tr><td>Cortisol (8 AM)</td><td>5-23 μg/dL</td></tr>
                <tr><td>ACTH</td><td>10-60 pg/mL</td></tr>
                <tr><td>Growth hormone</td><td>0-5 ng/mL</td></tr>
                <tr><td>Prolactin</td><td>2-15 ng/mL</td></tr>
                <tr><td>PTH</td><td>10-65 pg/mL</td></tr>
                <tr><td>HbA1c</td><td>4-5.6% (normal)</td></tr>
                <tr><td>Insulin (fasting)</td><td>2.6-24.9 μU/mL</td></tr>
            </table>
        </div>
        <div class="lab-section">
            <h3>Cardiac Markers</h3>
            <table>
                <tr><td>Troponin I</td><td><0.04 ng/mL</td></tr>
                <tr><td>CK-MB</td><td>0-5 ng/mL</td></tr>
                <tr><td>BNP</td><td><100 pg/mL</td></tr>
                <tr><td>NT-proBNP</td><td><300 pg/mL</td></tr>
            </table>
        </div>
        <div class="lab-section">
            <h3>Urinalysis</h3>
            <table>
                <tr><td>pH</td><td>4.5-8.0</td></tr>
                <tr><td>Specific gravity</td><td>1.003-1.030</td></tr>
                <tr><td>Protein</td><td>Negative</td></tr>
                <tr><td>Glucose</td><td>Negative</td></tr>
                <tr><td>Ketones</td><td>Negative</td></tr>
                <tr><td>Bilirubin</td><td>Negative</td></tr>
                <tr><td>Nitrites</td><td>Negative</td></tr>
                <tr><td>Leukocyte esterase</td><td>Negative</td></tr>
                <tr><td>WBC</td><td>0-5/hpf</td></tr>
                <tr><td>RBC</td><td>0-3/hpf</td></tr>
            </table>
        </div>
        <div class="lab-section">
            <h3>CSF</h3>
            <table>
                <tr><td>Opening pressure</td><td>70-180 mm H₂O</td></tr>
                <tr><td>Glucose</td><td>40-70 mg/dL</td></tr>
                <tr><td>Protein</td><td>15-45 mg/dL</td></tr>
                <tr><td>WBC</td><td>0-5 cells/μL</td></tr>
            </table>
        </div>
        <div class="lab-section">
            <h3>Immunology</h3>
            <table>
                <tr><td>IgG</td><td>700-1,600 mg/dL</td></tr>
                <tr><td>IgA</td><td>70-400 mg/dL</td></tr>
                <tr><td>IgM</td><td>40-230 mg/dL</td></tr>
                <tr><td>IgE</td><td>0-380 IU/mL</td></tr>
                <tr><td>C3</td><td>90-180 mg/dL</td></tr>
                <tr><td>C4</td><td>10-40 mg/dL</td></tr>
                <tr><td>CRP</td><td><1.0 mg/dL</td></tr>
            </table>
        </div>
    `;

    // ===== INITIALIZATION =====
    // ===== MOBILE SIDEBAR =====
    function toggleSidebar() {
        const sidebar = document.getElementById('sidebar');
        const overlay = document.getElementById('sidebar-overlay');
        sidebar.classList.toggle('open');
        overlay.classList.toggle('open');
    }

    function closeSidebar() {
        const sidebar = document.getElementById('sidebar');
        const overlay = document.getElementById('sidebar-overlay');
        sidebar?.classList.remove('open');
        overlay?.classList.remove('open');
    }

    function init() {
        // Check auth session
        if (typeof Auth !== 'undefined') {
            if (!Auth.checkSession()) return; // Will show login screen
        }
        navigate('dashboard');
        // Load data from server in background
        loadFromServer();
    }

    // Start the app
    init();

    // ===== PUBLIC API =====
    return {
        navigate,
        toggleSidebar,
        closeSidebar,
        toggleTopicGroup,
        toggleTopicCheck,
        toggleSubtopic,
        selectAllTopics,
        deselectAllTopics,
        toggleTutor,
        toggleTimed,
        setFilter,
        syncSlider,
        syncInput,
        startTest,
        selectChoice,
        strikethroughChoice,
        submitAnswer,
        prevQuestion,
        nextQuestion,
        goToQuestion,
        toggleFlag,
        toggleNavigator,
        endTestConfirm,
        finishTest,
        suspendTest,
        doSuspend,
        resumeTest,
        renderResults,
        filterResults,
        reviewTestQuestions,
        reviewQuestion,
        reviewTest,
        changeFontSize,
        toggleHighlight,
        openLab,
        closeLab,
        openCalc,
        closeCalc,
        calcInput,
        calcEval,
        calcClear,
        openNotes,
        closeNotes,
        saveNote,
        showExhibit,
        doSearch,
        searchFilter,
        searchByTopic,
        previewQuestion,
        resetProgress,
        loadFromServer,
    };
})();
