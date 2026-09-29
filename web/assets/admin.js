
        let data = {};

        // 只有真的从服务器读到了内容，才允许写回去。理由见 loadData()。
        let loadedFromServer = false;

        // 数据里的内容会直接拼进 innerHTML，里面的 < & " 会把结构撑坏
        // （项目描述里写个 C++ <algorithm> 就能让卡片错位）。插进 HTML 的文本都过这道。
        function esc(s) {
            return String(s ?? '').replace(/[&<>"']/g, c => (
                { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
            ));
        }

        // 把字符串放进 HTML 属性里用（data-* 的值，或 onclick 里的字符串字面量），
        // 读的时候用 decodeURIComponent 还原。比裸的 encodeURIComponent 多编码一个
        // 单引号 —— ' 是它的保留字符，不编码的话 onclick="fn('...')" 会被带撇号的
        // 名字截断，删除按钮就失灵了。
        const enc = (s) => encodeURIComponent(String(s ?? '')).replace(/'/g, '%27');

        // ============ 认证 ============
        // 密码存在服务器的 .env 里，前端源码中不再有任何明文密码。
        // 登录成功后服务器签发一个签名 token，所有写操作都要带上它。
        const TOKEN_KEY = 'portfolio_admin_token';
        const getToken = () => localStorage.getItem(TOKEN_KEY) || '';
        const authHeaders = () => ({ 'Authorization': 'Bearer ' + getToken() });

        // 这里刻意用内联样式而不是切类名：admin.css 里的
        // `html.has-token .auth-screen { display: none }` 只是用来决定
        // 「首次绘制时显不显示」，一旦开始校验就以这里的判断为准。
        // 内联样式优先级最高，正好能盖过那条规则。
        function showAuthScreen() {
            document.getElementById('auth-screen').style.display = 'flex';
            document.body.classList.add('unauthenticated');
        }

        function hideAuthScreen() {
            document.getElementById('auth-screen').style.display = 'none';
            document.body.classList.remove('unauthenticated');
        }

        async function checkAuth() {
            const input = document.getElementById('auth-password').value;
            const errorEl = document.getElementById('auth-error');
            const btn = document.querySelector('#auth-screen button');
            if (btn) { btn.disabled = true; btn.textContent = '验证中…'; }
            try {
                const res = await fetch('./api/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password: input }),
                });
                if (!res.ok) {
                    errorEl.textContent = res.status === 429 ? '尝试次数过多，请稍后再试' : '密码错误';
                    errorEl.style.display = 'block';
                    document.getElementById('auth-password').value = '';
                    return;
                }
                const { token } = await res.json();
                localStorage.setItem(TOKEN_KEY, token);
                errorEl.style.display = 'none';
                hideAuthScreen();
                await loadData();
                renderAll();
            } catch (e) {
                errorEl.textContent = '无法连接服务器';
                errorEl.style.display = 'block';
            } finally {
                if (btn) { btn.disabled = false; btn.textContent = '进入'; }
            }
        }

        async function hasValidSession() {
            if (!getToken()) return false;
            try {
                const res = await fetch('./api/session', { headers: authHeaders() });
                return res.ok;
            } catch (e) {
                return false;
            }
        }

        document.addEventListener('DOMContentLoaded', async () => {
            initNavigation();
            if (await hasValidSession()) {
                hideAuthScreen();
                await loadData();
                renderAll();
            } else {
                localStorage.removeItem(TOKEN_KEY);
                showAuthScreen();
            }
        });

        async function loadData() {
            // data.json 是唯一数据源，后台和前台读的是同一个文件
            loadedFromServer = false;
            try {
                const resp = await fetch('./data/data.json?_=' + Date.now());
                if (resp.ok) {
                    data = await resp.json();
                    loadedFromServer = true;
                } else {
                    console.error('[admin] 读取 data.json 失败：HTTP ' + resp.status);
                }
            } catch (e) {
                console.error('[admin] 读取 data.json 失败：', e);
                // 服务器暂时不可用时用本地缓存兜底，至少能打开后台看看
                try { data = JSON.parse(localStorage.getItem('portfolio_cache') || '{}'); } catch (e2) {}
            }

            if (!data.profile) data.profile = { name: '', title: '', subtitle: '', avatar: '', about: [], socialLinks: [], skills: {} };
            if (!data.games) data.games = [];
            if (!data.resume) data.resume = { contact: {}, target: {}, education: [], projects: [] };

            // 读不到就明说，并且停掉保存。上面这套默认值是给「本地缓存也空」
            // 兜底的，一旦被当成「用户把内容删光了」写回服务器，线上就没了。
            showLoadError(!loadedFromServer);
        }

        function showLoadError(failed) {
            const el = document.getElementById('load-error');
            if (!el) return;
            el.style.display = failed ? '' : 'none';
            document.body.classList.toggle('load-failed', failed);
        }

        function initNavigation() {
            document.querySelectorAll('.nav-item').forEach(item => {
                item.addEventListener('click', () => {
                    const panelId = item.dataset.panel;
                    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
                    item.classList.add('active');
                    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
                    document.getElementById('panel-' + panelId).classList.add('active');
                    if (window.innerWidth <= 768) toggleSidebar();
                });
            });
        }

        function toggleSidebar() {
            const sidebar = document.querySelector('.sidebar');
            const overlay = document.getElementById('sidebar-overlay');
            sidebar.classList.toggle('open');
            overlay.classList.toggle('active');
        }

        function renderAll() {
            renderProfile();
            renderVideosList();
            renderGames();
            renderResume();
            renderResumePdf();
        }

        function showToast(message) {
            const toast = document.getElementById('toast');
            toast.textContent = message;
            toast.classList.add('show');
            setTimeout(() => toast.classList.remove('show'), 3000);
        }

        // 所有改动都经过这一个出口：先写本地缓存（断网也不丢），再同步到服务器。
        // 500ms 防抖，拖拽排序时不会连打十几个请求。
        let saveTimer = null;

        function save() {
            // 内容都没读上来就写回去，等于用一副空骨架覆盖线上数据
            if (!loadedFromServer) {
                showToast('没能读到服务器上的内容，已阻止保存以免覆盖线上数据');
                return;
            }
            try { localStorage.setItem('portfolio_cache', JSON.stringify(data)); } catch (e) {}
            clearTimeout(saveTimer);
            saveTimer = setTimeout(pushToServer, 500);
        }

        async function pushToServer() {
            // 再挡一道：防抖这 500ms 里状态可能已经变了
            if (!loadedFromServer) return;
            try {
                const res = await fetch('./api/data', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json', ...authHeaders() },
                    body: JSON.stringify(data),
                });
                if (res.status === 401) {
                    showToast('登录已过期，请重新登录');
                    localStorage.removeItem(TOKEN_KEY);
                    setTimeout(() => location.reload(), 1500);
                    return;
                }
                if (!res.ok) throw new Error('HTTP ' + res.status);
            } catch (e) {
                showToast('保存失败，改动只存在本机：' + e.message);
            }
        }

        function renderProfile() {
            const p = data.profile || {};
            document.getElementById('profile-name').value = p.name || '';
            document.getElementById('profile-avatar').value = p.avatar || '';
            renderAvatarPreview();
            document.getElementById('profile-title').value = p.title || '';
            document.getElementById('profile-subtitle').value = p.subtitle || '';
            document.getElementById('profile-about').value = (p.about || []).join('\n');
            document.getElementById('profile-resume-pdf').value = p.resumePdf || '';
            document.getElementById('profile-sample-hint').style.display = p.sample ? '' : 'none';
            renderSkills();
            renderSocialLinks();
        }

        // 技能分类统一成 { tags: [], note: "" }。
        // 碰到旧的纯数组格式就地升级，免得老 data.json 一打开就报错。
        function skillEntry(cat) {
            if (!data.profile.skills) data.profile.skills = {};
            let v = data.profile.skills[cat];
            if (Array.isArray(v)) v = { tags: v, note: '' };
            if (!v || typeof v !== 'object') v = { tags: [], note: '' };
            if (!Array.isArray(v.tags)) v.tags = [];
            if (typeof v.note !== 'string') v.note = '';
            data.profile.skills[cat] = v;
            return v;
        }

        function renderSkills() {
            const container = document.getElementById('skills-container');
            const skills = data.profile.skills || {};
            container.innerHTML = Object.entries(skills).map(([cat, raw]) => {
                const { tags, note } = skillEntry(cat);
                return `
                <div class="form-group" style="margin-bottom: 1.25rem;">
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                        <label class="form-label" style="margin-bottom: 0.25rem;">${esc(cat)}</label>
                        <button class="btn btn-danger btn-small" onclick="removeSkillCategory('${enc(cat)}')" style="padding: 0.15rem 0.5rem; font-size: 0.75rem;">删除分类</button>
                    </div>
                    <div class="tag-input-container">
                        ${tags.map(item => `<span class="tag" data-cat="${enc(cat)}" data-item="${enc(item)}">${esc(item)}<span class="tag-remove" onclick="removeSkill(this)"> ×</span></span>`).join('')}
                        <input type="text" class="tag-input" placeholder="输入后回车" data-cat="${enc(cat)}" onkeydown="addSkill(event, this)">
                    </div>
                    <textarea class="form-textarea" rows="2" placeholder="一句话说明，显示在标签下方，可留空"
                              data-cat="${enc(cat)}" oninput="updateSkillNote(this)"
                              style="margin-top:0.5rem;font-size:0.85rem;">${esc(note)}</textarea>
                </div>`;
            }).join('') + `
                <div class="form-group" style="display: flex; gap: 0.5rem;">
                    <input type="text" class="form-input" id="new-skill-category" placeholder="新分类名称" style="flex: 1;">
                    <button class="btn btn-secondary btn-small" onclick="addSkillCategory()">添加分类</button>
                </div>
            `;
        }

        function addSkillCategory() {
            const cat = document.getElementById('new-skill-category').value.trim();
            if (!data.profile.skills) data.profile.skills = {};
            if (cat && !data.profile.skills[cat]) {
                data.profile.skills[cat] = { tags: [], note: '' };
                renderSkills();
            }
        }

        function addSkill(e, inputEl) {
            if (e.key === 'Enter') {
                const cat = decodeURIComponent(inputEl.dataset.cat);
                const val = inputEl.value.trim();
                const entry = skillEntry(cat);
                if (val && !entry.tags.includes(val)) {
                    entry.tags.push(val);
                    renderSkills();
                }
            }
        }

        function removeSkill(removeEl) {
            const tagEl = removeEl.closest('.tag');
            const cat = decodeURIComponent(tagEl.dataset.cat);
            const item = decodeURIComponent(tagEl.dataset.item);
            const entry = skillEntry(cat);
            entry.tags = entry.tags.filter(s => s !== item);
            renderSkills();
        }

        // 说明文字就地改数据，不重渲染（重渲染会让输入框失去焦点）。
        // 和标签一样，点「保存更改」才写回服务器。
        function updateSkillNote(textareaEl) {
            skillEntry(decodeURIComponent(textareaEl.dataset.cat)).note = textareaEl.value;
        }

        function removeSkillCategory(encodedCat) {
            const cat = decodeURIComponent(encodedCat);
            if (confirm(`确定删除分类"${cat}"吗？`)) {
                if (data.profile.skills) {
                    delete data.profile.skills[cat];
                    renderSkills();
                }
            }
        }

        function renderSocialLinks() {
            const container = document.getElementById('social-links-container');
            container.innerHTML = (data.profile.socialLinks || []).map((link, i) => `
                <div class="form-group" style="display: flex; gap: 0.5rem; align-items: center;">
                    <input type="text" class="form-input" value="${esc(link.name)}" placeholder="名称" style="flex: 1;" onchange="updateSocialLink(${i}, 'name', this.value)">
                    <input type="text" class="form-input" value="${esc(link.url)}" placeholder="链接" style="flex: 2;" onchange="updateSocialLink(${i}, 'url', this.value)">
                    <button class="btn btn-danger btn-small" onclick="removeSocialLink(${i})">删除</button>
                </div>
            `).join('');
        }

        function addSocialLink() { 
            if (!data.profile.socialLinks) data.profile.socialLinks = []; 
            data.profile.socialLinks.push({ name: '', url: '' }); 
            renderSocialLinks(); 
        }
        function updateSocialLink(i, field, val) { data.profile.socialLinks[i][field] = val; }
        function removeSocialLink(i) { data.profile.socialLinks.splice(i, 1); renderSocialLinks(); }

        function saveProfile() {
            if (!data.profile) data.profile = {};
            data.profile.name = document.getElementById('profile-name').value;
            data.profile.avatar = document.getElementById('profile-avatar').value;
            data.profile.title = document.getElementById('profile-title').value;
            data.profile.subtitle = document.getElementById('profile-subtitle').value;
            data.profile.about = document.getElementById('profile-about').value.split('\n').filter(l => l.trim());
            data.profile.resumePdf = document.getElementById('profile-resume-pdf').value.trim();
            // 自己动手改过就不再是示例了，去掉标记，
            // 以后传简历不会再来覆盖副标题
            delete data.profile.sample;
            save();
            showToast('已保存');
        }


        // ============ Videos Management ============
        function extractBvid(url) {
            const match = (url || '').match(/BV[a-zA-Z0-9]+/);
            return match ? match[0] : (url || '').trim();
        }

        function addVideo() {
            const title = document.getElementById('video-title').value.trim();
            const url = document.getElementById('video-url').value.trim();
            const desc = document.getElementById('video-desc').value.trim();
            if (!title || !url) { alert('请填写标题和链接'); return; }
            const bvid = extractBvid(url);
            data.videos = data.videos || [];
            data.videos.push({ title, bvid, url, description: desc });
            save();
            renderVideosList();
            document.getElementById('video-title').value = '';
            document.getElementById('video-url').value = '';
            document.getElementById('video-desc').value = '';
            showToast('视频添加成功');
        }

        function deleteVideo(index) {
            if (!confirm('确定删除该视频？')) return;
            data.videos.splice(index, 1);
            save();
            renderVideosList();
            showToast('视频已删除');
        }

        let dragSrcIdx = null;

        function renderVideosList() {
            const list = document.getElementById('videos-list');
            if (!list) return;
            const videos = data.videos || [];
            if (videos.length === 0) {
                list.innerHTML = '<div style="padding:1rem;color:var(--text-tertiary)">暂无视频，点击上方添加</div>';
                return;
            }
            list.innerHTML = videos.map((v, i) => `
                <div draggable="true" ondragstart="dragStart(${i})" ondragover="dragOver(event)" ondrop="dropVideo(${i})" ondragend="dragEnd()"
                     class="video-drag-item ${i === dragSrcIdx ? 'dragging' : ''}"
                     style="display:flex;justify-content:space-between;align-items:center;padding:0.75rem 1rem;border:1px solid var(--border-color);border-radius:var(--radius-md);margin-bottom:0.5rem;background:var(--bg-card);cursor:grab;transition:all 0.2s;">
                    <div style="display:flex;align-items:center;gap:0.75rem;flex:1;min-width:0;">
                        <span style="color:var(--text-tertiary);font-size:0.9rem;cursor:grab;">⠿</span>
                        <div style="min-width:0;">
                            <div style="font-weight:600;font-size:0.9rem;">${esc(v.title)}</div>
                            <div style="font-size:0.8rem;color:var(--text-tertiary);">${esc(v.bvid || v.url)}</div>
                        </div>
                    </div>
                    <div style="display:flex;align-items:center;gap:0.4rem;flex-shrink:0;">
                        ${i > 0 ? `<button onclick="moveVideo(${i}, -1)" style="background:none;border:1px solid var(--border-color);border-radius:6px;padding:0.2rem 0.5rem;cursor:pointer;font-size:0.8rem;color:var(--text-secondary);" title="上移">▲</button>` : ''}
                        ${i < videos.length - 1 ? `<button onclick="moveVideo(${i}, 1)" style="background:none;border:1px solid var(--border-color);border-radius:6px;padding:0.2rem 0.5rem;cursor:pointer;font-size:0.8rem;color:var(--text-secondary);" title="下移">▼</button>` : ''}
                        <button onclick="deleteVideo(${i})" style="background:#ef4444;color:#fff;border:none;padding:0.35rem 0.65rem;border-radius:6px;cursor:pointer;font-size:0.8rem;">删除</button>
                    </div>
                </div>
            `).join('');
        }

        function dragStart(idx) {
            dragSrcIdx = idx;
            setTimeout(() => document.querySelector('.video-drag-item.dragging')?.classList.add('dragging'), 0);
        }
        function dragOver(e) {
            e.preventDefault();
            document.querySelectorAll('.video-drag-item').forEach(el => el.style.borderColor = '');
            if (e.currentTarget) e.currentTarget.style.borderColor = 'var(--accent-blue)';
        }
        function dragEnd() {
            document.querySelectorAll('.video-drag-item').forEach(el => { el.style.borderColor = ''; el.classList.remove('dragging'); });
            dragSrcIdx = null;
        }
        function dropVideo(targetIdx) {
            if (dragSrcIdx === null || dragSrcIdx === targetIdx) return;
            const videos = data.videos || [];
            const [moved] = videos.splice(dragSrcIdx, 1);
            videos.splice(targetIdx, 0, moved);
            dragSrcIdx = null;
            save();
            renderVideosList();
            showToast('视频顺序已更新');
        }

        function moveVideo(idx, dir) {
            const target = idx + dir;
            const videos = data.videos || [];
            if (target < 0 || target >= videos.length) return;
            [videos[idx], videos[target]] = [videos[target], videos[idx]];
            save();
            renderVideosList();
        }

        function renderGames() {
            const container = document.getElementById('games-list');
            const games = data.games || [];
            if (!games.length) { container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">🎮</div>暂无游戏作品</div>'; return; }
            container.innerHTML = games.map((g, i) => `
                <div draggable="true" ondragstart="gameDragStart(${i})" ondragover="dragOver(event)" ondrop="dropGame(${i})" ondragend="dragEnd()"
                     class="game-drag-item"
                     style="display:flex;justify-content:space-between;align-items:center;padding:0.75rem 1rem;border:1px solid var(--border-color);border-radius:var(--radius-md);margin-bottom:0.5rem;background:var(--bg-card);cursor:grab;transition:all 0.2s;">
                    <div style="display:flex;align-items:center;gap:0.75rem;flex:1;min-width:0;">
                        <span style="color:var(--text-tertiary);font-size:0.9rem;cursor:grab;">⠿</span>
                        <div style="min-width:0;">
                            <div style="font-weight:600;font-size:0.9rem;">${esc(g.icon || '🎮')} ${esc(g.title)}${g.sample ? ' <span class="meta-tag" style="background:rgba(246,152,42,0.15);color:var(--accent-orange);" title="上传简历后会被自动移除">示例</span>' : ''}</div>
                            <div style="font-size:0.8rem;color:var(--text-secondary);margin-top:0.15rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:300px;">${esc((g.description || '').slice(0, 60))}</div>
                            <div class="data-item-meta" style="margin-top:0.3rem;">${(g.tech || []).map(t => `<span class="meta-tag">${esc(t)}</span>`).join('')}</div>
                        </div>
                    </div>
                    <div style="display:flex;align-items:center;gap:0.4rem;flex-shrink:0;">
                        ${i > 0 ? `<button onclick="moveGame(${i}, -1)" style="background:none;border:1px solid var(--border-color);border-radius:6px;padding:0.2rem 0.5rem;cursor:pointer;font-size:0.8rem;color:var(--text-secondary);" title="上移">▲</button>` : ''}
                        ${i < games.length - 1 ? `<button onclick="moveGame(${i}, 1)" style="background:none;border:1px solid var(--border-color);border-radius:6px;padding:0.2rem 0.5rem;cursor:pointer;font-size:0.8rem;color:var(--text-secondary);" title="下移">▼</button>` : ''}
                        <button class="btn btn-secondary btn-small" onclick="editGame(${i})" style="padding:0.25rem 0.55rem;font-size:0.8rem;">编辑</button>
                        <button class="btn btn-danger btn-small" onclick="deleteGame(${i})" style="padding:0.25rem 0.55rem;font-size:0.8rem;">删除</button>
                    </div>
                </div>
            `).join('');
        }

        let gameDragSrcIdx = null;
        function gameDragStart(idx) { gameDragSrcIdx = idx; }
        function dropGame(targetIdx) {
            if (gameDragSrcIdx === null || gameDragSrcIdx === targetIdx) return;
            const games = data.games || [];
            const [moved] = games.splice(gameDragSrcIdx, 1);
            games.splice(targetIdx, 0, moved);
            gameDragSrcIdx = null;
            save();
            renderGames();
            showToast('游戏顺序已更新');
        }
        function moveGame(idx, dir) {
            const target = idx + dir;
            const games = data.games || [];
            if (target < 0 || target >= games.length) return;
            [games[idx], games[target]] = [games[target], games[idx]];
            save();
            renderGames();
        }

        // Temporary images array for the open modal
        let tempGameImages = [];

        function openGameModal(index = null) {
            document.getElementById('game-modal').classList.add('active');
            document.getElementById('game-image-file').value = '';
            document.getElementById('game-image-url').value = '';
            tempGameImages = [];
            if (index !== null) {
                const g = data.games[index];
                document.getElementById('game-modal-title').textContent = '编辑游戏作品';
                document.getElementById('game-id').value = index;
                document.getElementById('game-title').value = g.title || '';
                document.getElementById('game-icon').value = g.icon || '';
                document.getElementById('game-desc').value = g.description || '';
                document.getElementById('game-link').value = g.link || '';
                renderTechTags(g.tech || []);
                // Load existing images
                tempGameImages = (g.images && g.images.length ? g.images : (g.image ? [g.image] : [])).slice();
                renderGameImages();
            } else {
                document.getElementById('game-modal-title').textContent = '添加游戏作品';
                document.getElementById('game-id').value = '';
                document.getElementById('game-title').value = '';
                document.getElementById('game-icon').value = '🎮';
                document.getElementById('game-desc').value = '';
                document.getElementById('game-link').value = '';
                renderTechTags([]);
                renderGameImages();
            }
        }

        function renderGameImages() {
            const container = document.getElementById('game-images-list');
            if (!tempGameImages.length) {
                container.innerHTML = '<span style="color:var(--text-tertiary);font-size:0.85rem;">暂无图片，点击上方添加</span>';
                return;
            }
            container.innerHTML = tempGameImages.map((img, i) => `
                <div class="game-image-item">
                    <img src="${esc(img)}" alt="图片${i+1}">
                    <button class="remove-btn" onclick="removeGameImage(${i})" title="删除">✕</button>
                    ${i > 0 ? `<button class="order-btn order-left" onclick="moveImage(${i}, -1)" title="左移">◀</button>` : ''}
                    ${i < tempGameImages.length - 1 ? `<button class="order-btn order-right" onclick="moveImage(${i}, 1)" title="右移">▶</button>` : ''}
                </div>
            `).join('');
        }

        // 图片上传到服务器落盘，data.json 里只存一个相对路径。
        // 以前是存 base64，几张图就能把 data.json 撑到几 MB，每个访客都要下载。
        function handleImageUpload(event) {
            const file = event.target.files[0];
            if (!file) return;
            if (file.size > 5 * 1024 * 1024) {
                showToast('图片不能超过 5MB');
                return;
            }
            const reader = new FileReader();
            reader.onload = async function (e) {
                try {
                    const res = await fetch('./api/upload', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', ...authHeaders() },
                        body: JSON.stringify({ dataUrl: e.target.result }),
                    });
                    if (!res.ok) throw new Error('HTTP ' + res.status);
                    const { url } = await res.json();
                    tempGameImages.push(url);
                    renderGameImages();
                } catch (err) {
                    showToast('图片上传失败：' + err.message);
                } finally {
                    document.getElementById('game-image-file').value = '';
                }
            };
            reader.readAsDataURL(file);
        }

        // ===== 头像 =====
        // Emoji 和图片共用 profile.avatar 一个字段：填 Emoji 就按文字渲染，
        // 填图片地址就渲染成圆形照片。判断依据是「有斜杠（路径 / URL）或带图片后缀」——
        // Emoji 两者都不占。
        // main.js 里有一份同样的（前台渲染时也要判断），改这里记得同步过去。
        function isAvatarImage(v) {
            return /[\/\\]/.test(v) || /\.(png|jpe?g|gif|webp|svg|avif)(\?|#|$)/i.test(v);
        }

        function renderAvatarPreview() {
            const box = document.getElementById('avatar-preview');
            const v = (data.profile && data.profile.avatar) || '';
            box.innerHTML = isAvatarImage(v) ? `<img src="${esc(v)}" alt="">` : esc(v);
        }

        // 上传即保存，不用再点「保存更改」—— 和换简历 PDF 一个道理，
        // 传完图忘了点保存的话，图在服务器上、地址却没写进 data.json，很费解。
        function handleAvatarUpload(event) {
            const file = event.target.files[0];
            if (!file) return;
            if (file.size > 5 * 1024 * 1024) {
                showToast('图片不能超过 5MB');
                event.target.value = '';
                return;
            }
            const reader = new FileReader();
            reader.onload = async function (e) {
                try {
                    const res = await fetch('./api/upload', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', ...authHeaders() },
                        body: JSON.stringify({ dataUrl: e.target.result }),
                    });
                    if (!res.ok) throw new Error('HTTP ' + res.status);
                    const { url } = await res.json();
                    if (!data.profile) data.profile = {};
                    // 这里不摘 profile.sample：头像不在同步流程会覆盖的字段里，
                    // 摘了反而会让「副标题还是示例」的那条自动补齐失效。
                    data.profile.avatar = url;
                    document.getElementById('profile-avatar').value = url;
                    save();
                    renderAvatarPreview();
                    showToast('头像已更新，前台刷新即可看到');
                } catch (err) {
                    showToast('图片上传失败：' + err.message);
                } finally {
                    document.getElementById('avatar-file').value = '';
                }
            };
            reader.readAsDataURL(file);
        }

        function clearAvatar() {
            if (!data.profile) data.profile = {};
            data.profile.avatar = '';
            document.getElementById('profile-avatar').value = '';
            save();
            renderAvatarPreview();
            showToast('头像已清除');
        }

        // 手填那一路：先更新预览，落盘还是走「保存更改」（和这个面板其它字段一致）
        function updateAvatarField(val) {
            if (!data.profile) data.profile = {};
            data.profile.avatar = val;
            renderAvatarPreview();
        }

        // 简历 PDF 走和图片一样的上传通道，落盘后把地址写进 profile.resumePdf。
        // 上传即保存，不用再点「保存更改」——换简历是个独立动作，忘点保存代价太大。
        const MAX_PDF_BYTES = 10 * 1024 * 1024;

        function handleResumePdfUpload(event) {
            const file = event.target.files[0];
            if (!file) return;
            const hint = document.getElementById('pdf-hint');
            if (file.type && file.type !== 'application/pdf') {
                showToast('只能上传 PDF 文件');
                event.target.value = '';
                return;
            }
            if (file.size > MAX_PDF_BYTES) {
                showToast('PDF 不能超过 10MB');
                event.target.value = '';
                return;
            }
            hint.textContent = '上传中…';
            const reader = new FileReader();
            reader.onload = async function (e) {
                try {
                    const res = await fetch('./api/upload', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', ...authHeaders() },
                        body: JSON.stringify({ dataUrl: e.target.result }),
                    });
                    if (!res.ok) throw new Error('HTTP ' + res.status);
                    const { url } = await res.json();
                    if (!data.profile) data.profile = {};
                    data.profile.resumePdf = url;
                    save();
                    renderResumePdf();
                    showToast('简历 PDF 已更新，前台刷新即可下载新版本');
                    // 顺手把简历里的内容读出来同步到站点。
                    // 这一步失败不影响上面已经生效的 PDF 替换。
                    await syncFromResumePdf(url);
                } catch (err) {
                    hint.textContent = '上传失败';
                    showToast('PDF 上传失败：' + err.message);
                } finally {
                    event.target.value = '';
                }
            };
            reader.readAsDataURL(file);
        }

        function clearResumePdf() {
            if (!confirm('确定清除简历 PDF 吗？清除后首页的下载按钮会消失。')) return;
            if (!data.profile) data.profile = {};
            data.profile.resumePdf = '';
            save();
            renderResumePdf();
            showToast('已清除，首页下载按钮不再显示');
        }

        // ============ 从简历 PDF 同步内容 ============
        // 上传新简历后，服务器把 PDF 读成结构化数据返回，这里合并进站点内容。
        // 两条规矩：
        //   1. 只有解析出来的字段才覆盖，没认出来的保持原样，绝不写空值
        //   2. 视频管理是独立的一块，整个流程不碰它
        // 保存前服务器会备份：server/backups/data.json.bak 是上一版，
        // 同目录的 data-*.json 是按时间留的快照（改了一轮才发现的话得靠它们）。

        /** 标题归一化，只取括号前的部分：「星轨回响(联机版)」能对上「星轨回响 (多人合作射击)」 */
        function titleKey(s) {
            return (s || '').split(/[(（]/)[0].replace(/[\s\-_·]/g, '').toLowerCase();
        }

        /**
         * 从技能说明文字里抠标签。
         *
         * 简历里没有「标签」这个结构，只有「1.分类：一整句说明」，所以只能按标点切开、
         * 剥掉开头的动词，把剩下的词当标签。抠出来的是近似值，宁可少几个也不要塞进
         * 半句话 —— 标签是给人扫的，带连接词（并/和/与）或者超过十个字的，基本就是
         * 句子而不是标签，一律丢掉。手写过的标签不会被这个函数碰到，见 applyResumePatch。
         */
        function extractTags(note) {
            if (!note) return [];
            const out = [];
            for (let s of String(note).split(/[，,、；;。.\n]+/)) {
                s = s.replace(/[（()）]/g, '').trim();
                if (!s) continue;
                // 剥开头的动词和程度词，可能要剥两层（「熟练使用Git」→「Git」）
                for (let i = 0; i < 3; i++) {
                    const t = s.replace(/^(目前是|现在|熟练使用|熟练掌握|熟练|掌握|熟悉|了解|精通|具备|使用|会用|能够|能|会|有|常用的|常见|基本的|扎实的|常用)/, '');
                    if (t === s) break;
                    s = t;
                }
                // 「Diversion等版本管理工具」这种，切到「等」为止
                s = s.replace(/等.*$/, '');
                s = s.replace(/^[的了和与及并]+/, '').replace(/[的了和与及并]+$/, '').trim();
                if (s.length < 2 || s.length > 24) continue;
                // 中文超过十个字基本是半句话了；纯英文的（Gameplay Framework）放宽
                if (/[一-龥]/.test(s) && s.length > 10) continue;
                if (/[并和与及]|使用|进行|能够|结合|需求|具有|经验|功能|知识|机制|能力|相关/.test(s)) continue;
                if (!out.includes(s)) out.push(s);
                if (out.length >= 10) break;   // 一行标签堆太多反而不好扫
            }
            return out;
        }

        function applyResumePatch(patch) {
            const changed = [];
            const p = patch.profile || {};
            const r = patch.resume || {};

            if (p.name) { data.profile.name = p.name; changed.push('昵称'); }
            if (p.title) { data.profile.title = p.title; changed.push('标题'); }
            if (p.about && p.about.length) { data.profile.about = p.about; changed.push('关于我'); }
            if (p.socialLinks && p.socialLinks.length) {
                // 按名称合并，不整个替换。解析只认 Phone / Email / QQ / 微信四种，
                // 整个替换的话，你在「个人信息 → 联系方式」里手加的行（知乎、博客…）
                // 传一次简历就没了。
                // 还是示例内容时例外：那几条本来就是虚构的，留着不如让简历里的真实信息盖掉。
                if (data.profile.sample) {
                    data.profile.socialLinks = p.socialLinks.slice();
                } else {
                    const next = (data.profile.socialLinks || []).slice();
                    const at = {};
                    next.forEach((l, i) => { at[String(l.name || '').toLowerCase()] = i; });
                    for (const link of p.socialLinks) {
                        const k = String(link.name || '').toLowerCase();
                        if (k in at) next[at[k]] = link;
                        else { at[k] = next.length; next.push(link); }
                    }
                    data.profile.socialLinks = next;
                }
                changed.push('联系方式');
            }

            if (p.skills) {
                // 分类以简历为准：简历里有的保留下来，简历里没有的分类删掉 ——
                // 否则示例里的分类会一直留在线上，越积越多。
                // 标签优先用手写的那份，只有一条都没有时才从说明文字里抠（见 extractTags）。
                const next = {};
                let kept = 0, added = 0, derived = 0;
                for (const [cat, note] of Object.entries(p.skills)) {
                    const old = (data.profile.skills || {})[cat];
                    const oldTags = Array.isArray(old) ? old : (old && Array.isArray(old.tags) ? old.tags : []);
                    const oldNote = old && typeof old.note === 'string' ? old.note : '';
                    const text = note || oldNote;
                    let tags = oldTags;
                    if (!tags.length) { tags = extractTags(text); if (tags.length) derived++; }
                    next[cat] = { tags, note: text };
                    if (old) kept++; else added++;
                }
                data.profile.skills = next;
                changed.push(`技能（保留 ${kept} 类${added ? `，新建 ${added} 类` : ''}`
                    + `${derived ? `，${derived} 类标签从说明文字里自动提取` : ''}）`);
            }

            // 邮箱 / 电话写进 resume.contact，但它只是前台 socialLinks 为空时的兜底
            // （联系方式在「个人信息」里编辑），所以这里不单独报一条，
            // 上面 socialLinks 那步已经报过「联系方式」了。
            if (r.contact) Object.assign(data.resume.contact, r.contact);
            if (r.target) { Object.assign(data.resume.target, r.target); changed.push('求职意向'); }
            if (r.education) { data.resume.education = r.education; changed.push('教育背景'); }

            // 副标题简历里没有对应的东西，示例站点上那句「示例大学 · …」会一直挂在首页。
            // 所以只要内容还是示例（profile.sample），就用教育背景 + 求职意向拼一句换掉；
            // 你自己在「个人信息」里改过之后 sample 就没了，以后再传简历都不会覆盖你写的。
            //
            // sample 只在这里摘，而且是拼出来了才摘（原来是无条件 delete 的）：
            // 副标题是同步流程里唯一「认不出教育背景就补不上」的字段，只要它还是示例
            // 那句就得留着标记，下次传一份排得更好的简历还有机会补 —— 否则示例文案会
            // 永远钉在首页，而后台那条「现在还是示例内容」的提示早就没了。
            const edu = (r.education || [])[0];
            if (edu && edu.school && data.profile.sample) {
                const bits = [edu.school];
                if (edu.major) bits.push(edu.major);
                // 届别 = 毕业年。正常情况就是区间里最后那个年份，但简历上那个区间
                // 未必是「入学 → 毕业」：见过写「2024-09 至 2026-03」的，那是写到
                // 简历更新那天为止，四年制本科实际是 2028 届。所以再拿「入学年 + 学制」
                // 兜一下，两者取大的 —— 正常区间两个值相等，写岔了也能算对。
                // 写「至今」的还没毕业，不猜。
                const years = (edu.year || '').match(/20\d{2}/g);
                if (years && years.length && !/至今/.test(edu.year)) {
                    const enroll = Number(years[0]);
                    const end = Number(years[years.length - 1]);
                    let grad = end;
                    // 只有一个年份时无从判断学制，照原样用
                    if (years.length >= 2) {
                        const span = /专科|高职/.test(edu.degree || '') ? 3
                                   : /硕士|研究生/.test(edu.degree || '') ? 3 : 4;
                        grad = Math.max(end, enroll + span);
                    }
                    bits.push(`${grad} 届`);
                }
                const pos = (r.target && r.target.position) || p.title;
                data.profile.subtitle = bits.join(' · ') + (pos ? ` | ${pos}` : '');
                changed.push('副标题');
                delete data.profile.sample;
            }

            if (r.activities) { data.resume.activities = r.activities; changed.push('在校经历'); }
            if (r.projects) { data.resume.projects = r.projects; changed.push('项目经历'); }

            // 作品卡片三件事：
            //   1. 标了 sample 的示例卡片删掉 —— 不删的话虚构作品会一直留在线上，
            //      上传完简历作品区还是别人的作品，这是最劝退的地方
            //   2. 标题对得上的刷新描述和技术栈，图标 / 截图 / 外链保留
            //      （那些是站点特有的，简历里没有，重建会弄丢）
            //   3. 对不上的用简历里的项目直接建一张卡，截图和外链留空，之后再补
            const matched = [], created = [], dropped = [];
            if (r.projects) {
                data.games = (data.games || []).filter(g => {
                    if (!g.sample) return true;
                    dropped.push(g.title);
                    return false;
                });
                for (const proj of r.projects) {
                    const key = titleKey(proj.name);
                    const game = data.games.find(g => titleKey(g.title) === key);
                    if (game) {
                        game.description = proj.description;
                        if (proj.tech && proj.tech.length) game.tech = proj.tech;
                        matched.push(game.title);
                    } else {
                        data.games.push({
                            id: Date.now() + data.games.length,
                            title: proj.name,
                            icon: '🎮',
                            image: '',
                            images: [],
                            description: proj.description,
                            tech: proj.tech || [],
                            link: '',
                        });
                        created.push(proj.name);
                    }
                }
            }
            if (matched.length) changed.push(`作品卡片刷新（${matched.join('、')}）`);
            if (created.length) changed.push(`作品卡片新建（${created.join('、')}）`);
            if (dropped.length) changed.push(`移除示例作品（${dropped.length} 个）`);

            return { changed, matched, created, dropped };
        }

        async function syncFromResumePdf(url) {
            const hint = document.getElementById('pdf-hint');
            hint.textContent = '正在读取简历内容…';
            try {
                const res = await fetch('./api/resume/parse', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', ...authHeaders() },
                    body: JSON.stringify({ url }),
                });
                if (res.status === 401) { hint.textContent = '登录已过期，内容未同步'; return; }
                if (!res.ok) {
                    const body = await res.json().catch(() => ({}));
                    hint.textContent = 'PDF 已替换，但内容没能识别（'
                        + (body.error || 'HTTP ' + res.status) + '），站点内容保持原样';
                    return;
                }

                const { patch, report, warnings } = await res.json();
                const { changed } = applyResumePatch(patch);
                save();
                renderAll();

                hint.textContent = '已同步：' + (changed.join('、') || '无变化')
                    + (warnings.length ? ' ｜ 未识别：' + warnings.join('；') : '');
                showToast('简历内容已同步到展示页面');
            } catch (e) {
                hint.textContent = 'PDF 已替换，但内容同步失败：' + e.message;
            }
        }

        function formatSize(bytes) {
            if (bytes < 1024) return bytes + ' B';
            if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
            return (bytes / 1024 / 1024).toFixed(1) + ' MB';
        }

        async function renderResumePdf() {
            const path = (data.profile && data.profile.resumePdf) || '';
            const nameEl = document.getElementById('pdf-current-name');
            const pathEl = document.getElementById('pdf-current-path');
            const dl = document.getElementById('pdf-download');
            const clearBtn = document.getElementById('pdf-clear');
            document.getElementById('pdf-hint').textContent = '';

            pathEl.textContent = path;
            dl.href = path || '#';
            [dl, clearBtn].forEach(el => el.classList.toggle('disabled', !path));

            // 手填的路径也要同步回「个人信息」里的输入框，两边永远显示同一个值
            const input = document.getElementById('profile-resume-pdf');
            if (input) input.value = path;

            nameEl.classList.remove('empty', 'warn');
            if (!path) {
                nameEl.textContent = '未配置';
                nameEl.classList.add('empty');
                return;
            }
            if (!path.startsWith('./') && !path.startsWith('/')) {
                // 外链没法探测，直接认了
                nameEl.textContent = '已配置（外部链接）';
                return;
            }

            // HEAD 一下确认文件真的躺在服务器上，顺便显示体积。
            // 传完发现路径写错、前台点了 404 是最常见的坑，这里提前暴露。
            nameEl.textContent = '已配置';
            try {
                const res = await fetch(path, { method: 'HEAD', cache: 'no-store' });
                if (!res.ok) throw new Error('HTTP ' + res.status);
                const size = Number(res.headers.get('content-length'));
                nameEl.textContent = '已配置' + (size ? ' · ' + formatSize(size) : '');
            } catch (e) {
                nameEl.textContent = '已配置，但文件取不到 —— 路径可能不对';
                nameEl.classList.add('warn');
            }
        }

        function addImageUrl() {
            const url = document.getElementById('game-image-url').value.trim();
            if (!url) { showToast('请输入图片链接'); return; }
            tempGameImages.push(url);
            renderGameImages();
            document.getElementById('game-image-url').value = '';
        }

        function removeGameImage(idx) {
            tempGameImages.splice(idx, 1);
            renderGameImages();
        }

        function moveImage(idx, dir) {
            const target = idx + dir;
            if (target < 0 || target >= tempGameImages.length) return;
            [tempGameImages[idx], tempGameImages[target]] = [tempGameImages[target], tempGameImages[idx]];
            renderGameImages();
        }

        function closeGameModal() { document.getElementById('game-modal').classList.remove('active'); }

        function saveGame() {
            const id = document.getElementById('game-id').value;
            const images = tempGameImages.slice();
            const gameData = {
                id: id ? parseInt(id) : Date.now(),
                title: document.getElementById('game-title').value,
                icon: document.getElementById('game-icon').value,
                image: images.length > 0 ? images[0] : '',
                images: images,
                description: document.getElementById('game-desc').value,
                tech: getCurrentTechTags(),
                link: document.getElementById('game-link').value
            };
            // 编辑过的示例卡片就归你了，去掉 sample 标记，
            // 免得下次上传简历时被当成示例删掉
            delete gameData.sample;
            if (!data.games) data.games = [];
            if (id) data.games[parseInt(id)] = gameData;
            else data.games.push(gameData);
            closeGameModal();
            renderGames();
            save();
            showToast('已保存');
        }

        function editGame(i) { openGameModal(i); }
        function deleteGame(i) { if (confirm('确定删除？')) { data.games.splice(i, 1); renderGames(); save(); showToast('已删除'); } }

        function renderResume() {
            const r = data.resume || {};
            document.getElementById('resume-location').value = r.contact?.location || '';

            document.getElementById('resume-target-position').value = r.target?.position || '';
            document.getElementById('resume-target-city').value = r.target?.city || '';
            document.getElementById('resume-target-salary').value = r.target?.salary || '';
            document.getElementById('resume-target-type').value = r.target?.type || '';
            
            renderEducation(r.education || []);
            renderProjects(r.projects || []);
        }

        function renderEducation(list) {
            const c = document.getElementById('education-list');
            c.innerHTML = !list.length ? '<p style="color: var(--text-tertiary)">暂无教育背景</p>' : list.map((e, i) => `
                <div class="timeline-item-form">
                    <div class="timeline-item-header"><span class="timeline-item-number">#${i+1}</span><button class="btn btn-danger btn-small" onclick="deleteEducation(${i})">删除</button></div>
                    <div class="form-group"><label class="form-label">学校</label><input type="text" class="form-input" value="${esc(e.school)}" onchange="updateEducation(${i}, 'school', this.value)"></div>
                    <div class="form-group"><label class="form-label">学位</label><input type="text" class="form-input" value="${esc(e.degree)}" onchange="updateEducation(${i}, 'degree', this.value)"></div>
                    <div class="form-group"><label class="form-label">主修专业</label><input type="text" class="form-input" value="${esc(e.major)}" onchange="updateEducation(${i}, 'major', this.value)"></div>
                    <div class="form-group"><label class="form-label">时间</label><input type="text" class="form-input" value="${esc(e.year)}" onchange="updateEducation(${i}, 'year', this.value)"></div>
                    <div class="form-group full-width"><label class="form-label">相关课程</label><textarea class="form-textarea" rows="2" onchange="updateEducation(${i}, 'courses', this.value)">${esc(e.courses)}</textarea></div>
                </div>
            `).join('');
        }

        function addEducation() { 
            if (!data.resume) data.resume = {};
            if (!data.resume.education) data.resume.education = []; 
            data.resume.education.push({ school: '', degree: '', major: '', year: '', courses: '' }); 
            renderEducation(data.resume.education); 
        }
        function updateEducation(i, f, v) { data.resume.education[i][f] = v; }
        function deleteEducation(i) { data.resume.education.splice(i, 1); renderEducation(data.resume.education); }

        function renderProjects(list) {
            const c = document.getElementById('projects-list');
            c.innerHTML = !list.length ? '<p style="color: var(--text-tertiary)">暂无项目经历</p>' : list.map((p, i) => `
                <div class="timeline-item-form">
                    <div class="timeline-item-header"><span class="timeline-item-number">#${i+1}</span><button class="btn btn-danger btn-small" onclick="deleteProject(${i})">删除</button></div>
                    <div class="form-group"><label class="form-label">项目名称</label><input type="text" class="form-input" value="${esc(p.name)}" onchange="updateProject(${i}, 'name', this.value)"></div>
                    <div class="form-group"><label class="form-label">项目角色</label><input type="text" class="form-input" value="${esc(p.role)}" onchange="updateProject(${i}, 'role', this.value)"></div>
                    <div class="form-group"><label class="form-label">项目时间</label><input type="text" class="form-input" value="${esc(p.time)}" onchange="updateProject(${i}, 'time', this.value)"></div>
                    <div class="form-group full-width"><label class="form-label">详细内容</label><textarea class="form-textarea" rows="3" onchange="updateProject(${i}, 'description', this.value)">${esc(p.description)}</textarea></div>
                </div>
            `).join('');
        }

        function addProject() { 
            if (!data.resume) data.resume = {};
            if (!data.resume.projects) data.resume.projects = []; 
            data.resume.projects.push({ name: '', role: '', time: '', description: '' }); 
            renderProjects(data.resume.projects); 
        }
        function updateProject(i, f, v) { data.resume.projects[i][f] = v; }
        function deleteProject(i) { data.resume.projects.splice(i, 1); renderProjects(data.resume.projects); }

        function saveResume() {
            if (!data.resume) data.resume = {};
            // 只改所在地这一项。这里原来是把整个 contact 重建一遍的，
            // 现在表单上只剩所在地了，重建会把简历解析写进来的 email / phone 抹掉
            // （它们是前台 socialLinks 为空时的兜底）。
            if (!data.resume.contact) data.resume.contact = {};
            data.resume.contact.location = document.getElementById('resume-location').value;
            data.resume.target = {
                position: document.getElementById('resume-target-position').value,
                city: document.getElementById('resume-target-city').value,
                salary: document.getElementById('resume-target-salary').value,
                type: document.getElementById('resume-target-type').value
            };
            save();
            showToast('已保存');
        }

        function renderTechTags(tags) {
            const container = document.getElementById('game-tech-container');
            const input = document.getElementById('game-tech-input');
            container.innerHTML = tags.map(t => `<span class="tag">${esc(t)}<span class="tag-remove" onclick="removeTechTag('${enc(t)}')"> ×</span></span>`).join('');
            container.appendChild(input);
        }

        function getCurrentTechTags() {
            const tags = [];
            document.querySelectorAll('#game-tech-container .tag').forEach(t => tags.push(t.textContent.replace(' ×', '').trim()));
            return tags;
        }

        function removeTechTag(encodedTag) {
            const tag = decodeURIComponent(encodedTag);
            const tags = getCurrentTechTags().filter(t => t !== tag);
            renderTechTags(tags);
        }

        document.getElementById('game-tech-input')?.addEventListener('keydown', e => {
            if (e.key === 'Enter') {
                e.preventDefault();
                const val = e.target.value.trim();
                if (val && !getCurrentTechTags().includes(val)) { renderTechTags([...getCurrentTechTags(), val]); }
                e.target.value = '';
            }
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                document.querySelectorAll('.modal-overlay.active').forEach(m => m.classList.remove('active'));
            }
        });

        document.querySelectorAll('.modal-overlay').forEach(overlay => {
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) overlay.classList.remove('active');
            });
        });

        function logout() {
            localStorage.removeItem(TOKEN_KEY);
            location.reload();
        }

        function toggleTheme() {
            const root = document.documentElement;
            const currentTheme = root.getAttribute('data-theme');
            const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
            root.setAttribute('data-theme', newTheme);
            localStorage.setItem('theme', newTheme);
            updateThemeButton(newTheme);
        }

        function updateThemeButton(theme) {
            const btn = document.getElementById('theme-toggle-btn');
            if (btn) {
                btn.textContent = theme === 'dark' ? '切换浅色模式' : '切换深色模式';
            }
        }

        // data-theme 已经在 admin.html 的 <head> 里设好了（那段得赶在首次绘制前跑，
        // 放在这里就晚了，会先按浅色画一帧）。这里只把按钮文字对上。
        //
        // 关键是 data-theme 必须已经落到了元素上：toggleTheme() 读的是它 ——
        // 系统是深色、又从没手动切过的用户，如果属性是 null，第一次点「切换」
        // 算出来还是 dark，看着像按钮坏了（得点第二次才对）。head 里那段
        // 无论走哪条分支都会显式 setAttribute，所以这里不用再兜一次。
        updateThemeButton(document.documentElement.getAttribute('data-theme'));
    