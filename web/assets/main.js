
        // Theme Toggle
        function toggleTheme() {
            const html = document.documentElement;
            const isDark = html.getAttribute('data-theme') === 'dark';
            html.setAttribute('data-theme', isDark ? 'light' : 'dark');
            localStorage.setItem('theme', isDark ? 'light' : 'dark');
            updateThemeIcon(!isDark);
        }

        function updateThemeIcon(isDark) {
            const icon = document.getElementById('theme-icon');
            if (isDark) {
                icon.innerHTML = '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>';
            } else {
                icon.innerHTML = '<circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>';
            }
        }

        // Init Theme
        // data-theme 已经在 index.html 的 <head> 里设好了（那段得赶在首次绘制前跑，
        // 放在这里就晚了，深色会闪一下白屏）。这里只把图标对上，别再算一遍 ——
        // 两处各算各的，改了一处忘了另一处就会图标和主题对不上。
        updateThemeIcon(document.documentElement.getAttribute('data-theme') === 'dark');

        document.getElementById('year').textContent = new Date().getFullYear();

        // 内容来自 data.json，会被拼进 innerHTML。里面的 < & " 会把结构撑坏
        // （项目描述里写个 C++ <algorithm> 就能让卡片错位），插进 HTML 的文本都过这道。
        function esc(s) {
            return String(s ?? '').replace(/[&<>"']/g, c => (
                { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
            ));
        }

        // Load Data
        let siteData = {};
        async function loadData() {
            try {
                // data.json is the single source of truth — the admin panel writes
                // to it through the server, so every visitor sees the same content.
                const res = await fetch('./data/data.json?_=' + Date.now());
                if (res.ok) {
                    siteData = await res.json();
                    // Keep a local copy only so the page still renders if the
                    // server is briefly unreachable. Never preferred over it.
                    try {
                        localStorage.setItem('portfolio_cache', JSON.stringify(siteData));
                    } catch (e) {}
                    render();
                    return;
                }
            } catch (e) {
                console.warn('Server unreachable, falling back to local cache:', e);
            }
            try {
                const cached = localStorage.getItem('portfolio_cache');
                if (cached) {
                    siteData = JSON.parse(cached);
                    render();
                }
            } catch (e) {}
        }

        function render() {
            const p = siteData.profile || {};
            const r = siteData.resume || {};

            // 横幅
            document.title = p.name ? `${p.name} · 个人简历` : '个人简历 · 作品集';
            document.getElementById('banner-title').innerHTML = `您好，我是 <span>${esc(p.name)}</span>`;
            document.getElementById('banner-subtitle').textContent = p.subtitle || '';
            // 小标签用「职位」，没填就退回求职意向里的岗位。赋空字符串时
            // CSS 的 .banner-tag:empty 会把整个标签收起来，不用在这里管显示隐藏。
            document.getElementById('banner-tag').textContent = p.title || (r.target || {}).position || '';
            document.getElementById('footer-name').textContent = p.name || '';

            renderProfileCard();

            // Job Target。开关挂在板块 #target 上而不是信息条上：
            // 这块只有这一条内容，没数据时连标题一起收掉，别留个空壳子。
            const t = r.target || {};
            const jobTargetEl = document.getElementById('job-target');
            const targetBlock = document.getElementById('target');
            if (t.position || t.city || t.salary) {
                jobTargetEl.innerHTML = `
                    <div class="job-target-label">求职意向</div>
                    <div class="job-target-value">${esc(t.position)}</div>
                    <div class="job-target-meta">
                        ${t.city ? `<span class="job-target-meta-item">📍 ${esc(t.city)}</span>` : ''}
                        ${t.salary ? `<span class="job-target-meta-item">💰 ${esc(t.salary)}</span>` : ''}
                        ${t.type ? `<span class="job-target-meta-item">⏰ ${esc(t.type)}</span>` : ''}
                    </div>
                `;
                targetBlock.classList.add('is-visible');
            } else {
                targetBlock.classList.remove('is-visible');
            }

            const skillsHtml = Object.entries(p.skills || {}).map(([cat, val]) => {
                // 新格式是 { tags, note }；旧的纯数组格式也认，免得老 data.json 渲染不出来
                const tags = Array.isArray(val) ? val : (val.tags || []);
                const note = Array.isArray(val) ? '' : (val.note || '');
                // 一行一类：类名靠左对齐成一列，标签和说明在右边（见 style.css 的 .skill-row）。
                // 一条标签都没有的分类（简历同步时抠不出来就会这样）加个 no-tags：
                // 那时说明文字是这行唯一的内容，再按小号灰字的脚注样式渲染就像被降级了。
                return `
                <div class="skill-row${tags.length ? '' : ' no-tags'}">
                    <div class="skill-cat">${esc(cat)}</div>
                    <div class="skill-body">
                        ${tags.length ? `<div class="skill-tags">
                            ${tags.map(item => `<span class="skill-tag">${esc(item)}</span>`).join('')}
                        </div>` : ''}
                        ${note ? `<p class="skill-note">${esc(note)}</p>` : ''}
                    </div>
                </div>`;
            }).join('');
            document.getElementById('skills-grid').innerHTML = skillsHtml;

            // Games
            const games = siteData.games || [];
            document.getElementById('games-grid').innerHTML = games.map((game, i) => `
                <div class="card" onclick="openGame(${i})">
                    <div class="card-icon">${esc(game.icon || '🎮')}</div>
                    <h3 class="card-title">${esc(game.title)}</h3>
                    <p class="card-desc">${esc(game.description)}</p>
                    <div class="card-tags">
                        ${(game.tech || []).map(t => `<span class="card-tag">${esc(t)}</span>`).join('')}
                    </div>
                </div>
            `).join('');

            // Videos —— 点击播放：不嵌 iframe，先显示占位，点 ▶ 才加载播放器。
            // 不点视频的访客不会加载 B 站的播放器脚本（页面更快，控制台也没有
            // B 站那堆 fingerprint 噪音 —— 那是 iframe 内部脚本打的，父页面
            // 屏蔽不了，只能不加载）。
            const videos = siteData.videos || [];
            if (videos.length > 0) {
                document.getElementById('videos-grid').innerHTML = videos.map((video, i) => {
                    const bvid = video.bvid || (video.url || '').match(/BV[a-zA-Z0-9]+/)?.[0] || '';
                    if (!bvid) return '';
                    return `
                        <div class="video-card">
                            <div class="video-thumbnail" id="video-thumb-${i}">
                                <div class="video-placeholder" onclick="playVideo(${i})" title="点击播放">
                                    <div class="video-play-btn">▶</div>
                                </div>
                            </div>
                            <div class="video-info">
                                <h3 class="video-title">${esc(video.title)}</h3>
                                ${video.description ? `<p class="video-desc">${esc(video.description)}</p>` : ''}
                            </div>
                        </div>
                    `;
                }).join('');
            } else {
                document.getElementById('videos-grid').innerHTML = '<p style="color: var(--text-tertiary); text-align: center; grid-column: 1/-1;">暂无视频</p>';
            }

        }

        // 头像字段里填的是 Emoji 还是图片地址。有斜杠（路径 / URL）或带图片后缀就算图片。
        // 后台 admin.js 里有一份同样的，两边要一起改。
        function isAvatarImage(v) {
            return /[\/\\]/.test(v) || /\.(png|jpe?g|gif|webp|svg|avif)(\?|#|$)/i.test(v);
        }

        // ===== 左栏个人卡 =====
        // 内容散在 profile 和 resume 两处，这里拼成一张卡。每一段都先判空再拼 ——
        // 后台可以把任意一项留空，缺字段就整段不渲染，别留个空壳子在那儿。
        function renderProfileCard() {
            const p = siteData.profile || {};
            const r = siteData.resume || {};
            const c = r.contact || {};
            const edu = (r.education || [])[0] || {};
            let html = '';

            // 头像既能是 Emoji 也能是图片（后台可以传）。判断依据是「有斜杠（路径 / URL）
            // 或带图片后缀」—— Emoji 两者都不占。
            // admin.js 里有一份同样的（后台预览要用），改这里记得同步过去。
            if (p.avatar) {
                html += isAvatarImage(p.avatar)
                    ? `<div class="profile-avatar"><img src="${esc(p.avatar)}" alt="${esc(p.name || '')}"></div>`
                    : `<div class="profile-avatar">${esc(p.avatar)}</div>`;
            }
            html += `<div class="profile-name">${esc(p.name)}</div>`;
            if (p.subtitle) html += `<p class="profile-subtitle">${esc(p.subtitle)}</p>`;

            // 联系方式：图标 + 值直接显示，不做点击展开。左栏空间够，
            // 而且邮箱电话本来就是给人看的，藏起来反而要多点一下。
            const links = contactLinks(p, c);
            if (links.length) {
                html += '<hr class="profile-divider"><ul class="profile-contact">';
                html += links.map(l => {
                    const href = linkHref(l.url);
                    const inner = `<span class="contact-icon">${socialIcon(l.name)}</span>`
                                + `<span class="contact-text">${esc(linkText(l))}</span>`;
                    if (!href) return `<li>${inner}</li>`;
                    // 站外链接开新标签；mailto: / tel: 留在当前页
                    const ext = /^https?:/i.test(href) ? ' target="_blank" rel="noopener"' : '';
                    return `<li><a href="${esc(href)}"${ext}>${inner}</a></li>`;
                }).join('');
                html += '</ul>';
            }

            const facts = [
                ['院校', edu.school],
                ['专业', [edu.degree, edu.major].filter(Boolean).join(' · ')],
                ['在校', edu.year],
                ['所在地', c.location],
            ].filter(([, v]) => v);
            if (facts.length) {
                html += '<hr class="profile-divider"><ul class="profile-facts">';
                html += facts.map(([k, v]) =>
                    `<li><span class="fact-key">${esc(k)}</span><span class="fact-value">${esc(v)}</span></li>`
                ).join('');
                html += '</ul>';
            }

            // 关于我。以前是右栏一张张带图标的卡片，现在挪进左栏，改成紧凑的段落 ——
            // 300px 宽的栏里再套卡片边框，一屏就装不下几句了。
            // 每段写成「标题：内容」的拆成「小标题 + 正文」，没有冒号的按普通段落处理。
            const about = (p.about || []).filter(Boolean);
            if (about.length) {
                html += '<hr class="profile-divider"><div class="profile-about">';
                html += about.map(text => {
                    // 只认开头 2-8 个字、且不含其他标点的「短标题：」，避免误切正常句子里的冒号
                    const m = text.match(/^([^：:，。；]{2,8})[：:]\s*([\s\S]+)$/);
                    const lead = m ? m[1].trim() : '';
                    const body = m ? m[2] : text;
                    return `<p class="about-item">`
                         + (lead ? `<span class="about-lead">${esc(lead)}</span>` : '')
                         + `${esc(body)}</p>`;
                }).join('');
                html += '</div>';
            }

            // 简历 PDF 下载按钮：地址由后台配置，没配就整块不渲染
            if (p.resumePdf) {
                // 上传的文件名是时间戳（如 1790081750725-24cb6336.pdf），
                // 不覆盖的话访客下到手的就是这串数字。download 属性只在同源时生效，
                // 简历正好是同源的 ./uploads/xxx.pdf。
                const who = (p.name || '').replace(/[\\/:*?"<>|]/g, '').trim();
                const fname = who ? `${who}-简历.pdf` : '简历.pdf';
                html += `<hr class="profile-divider"><div class="profile-actions">
                    <a class="btn btn-primary" id="resume-download" href="${esc(p.resumePdf)}" download="${esc(fname)}">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                            <polyline points="7 10 12 15 17 10"></polyline>
                            <line x1="12" y1="15" x2="12" y2="3"></line>
                        </svg>
                        <span>下载简历 PDF</span>
                    </a>
                </div>`;
            }

            document.getElementById('profile-card').innerHTML = html;
        }

        // 联系方式归一化成 [{ name, url }]。
        // profile.socialLinks 是主来源，resume.contact 只在它为空时兜底 ——
        // 这两处装的是同一批信息（上传简历时 applyResumePatch 会同时写），
        // 都渲染出来就是邮箱和电话各显示两遍。
        function contactLinks(p, c) {
            const list = (p.socialLinks || []).filter(l => l && (l.name || l.url));
            if (list.length) return list;
            const out = [];
            if (c.email) out.push({ name: 'Email', url: 'mailto:' + c.email });
            if (c.phone) out.push({ name: 'Phone', url: 'tel:' + c.phone });
            if (c.github) out.push({ name: 'GitHub', url: c.github });
            return out;
        }

        // 卡片上显示的那行字：去掉 mailto: / tel: / https:// 前缀和结尾的斜杠，
        // 邮箱和网址才不至于长到把 300px 的卡片撑破。没有 url 时退回名字。
        function linkText(l) {
            const t = String(l.url || '').trim()
                .replace(/^(mailto:|tel:)/i, '')
                .replace(/^https?:\/\//i, '')
                .replace(/\/$/, '');
            return t || l.name || '';
        }

        // 后台填的联系方式可能已经是完整 URL，也可能只写了 someone@x.com 或
        // github.com/xxx。补成能点的地址；实在认不出来返回空串，调用方退化成纯文本。
        function linkHref(url) {
            const s = String(url || '').trim();
            if (!s) return '';
            if (/^(https?:|mailto:|tel:)/i.test(s)) return s;
            if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return 'mailto:' + s;
            if (/^[\w-]+(\.[\w-]+)+(\/|$)/.test(s)) return 'https://' + s;
            return '';
        }

        // 联系方式那一行的小图标。名字是后台随便填的，也可能是简历解析出来的
        // （parseHead 会产出 Phone / Email / QQ / WeChat 四种），认不出来就给通用图标。
        function socialIcon(name) {
            const n = String(name || '').toLowerCase();
            if (/mail|邮箱|邮件/.test(n)) return '✉️';
            if (/phone|tel|电话|手机/.test(n)) return '📱';
            if (/github|git|代码/.test(n)) return '🐙';
            if (/blog|web|site|主页|博客|网站/.test(n)) return '🌐';
            if (/bilibili|视频/.test(n)) return '📺';
            if (/wechat|微信|qq|知乎|zhihu|微博|weibo/.test(n)) return '💬';
            return '🔗';
        }

        // 点击播放：把占位换成真正的 B 站播放器。
        // 播放器是 iframe，挂上去之后它的内部脚本才跑起来（包括那几行
        // fingerprint 噪音）—— 那是访客主动点了才发生，且不影响页面本身。
        function playVideo(index) {
            const video = siteData.videos[index];
            if (!video) return;
            const bvid = video.bvid || (video.url || '').match(/BV[a-zA-Z0-9]+/)?.[0] || '';
            if (!bvid) return;
            const wrap = document.getElementById('video-thumb-' + index);
            if (!wrap || wrap.dataset.loaded) return;
            wrap.dataset.loaded = '1';
            // bvid 进的是 URL，后台手填的 bvid 不一定干净，编码一下
            wrap.innerHTML = `<iframe src="https://player.bilibili.com/player.html?bvid=${encodeURIComponent(bvid)}&page=1" allowfullscreen loading="lazy"></iframe>`;
        }

        // Carousel state
        let carouselImages = [];
        let carouselIndex = 0;
        let carouselTimer = null;

        function openGame(index) {
            const game = siteData.games[index];
            if (!game) return;

            document.getElementById('modal-title').textContent = game.title;

            // Collect images from game.images or fallback to game.image
            carouselImages = (game.images && game.images.length) ? game.images : (game.image ? [game.image] : []);
            carouselIndex = 0;

            let html = '';

            // Carousel
            if (carouselImages.length > 1) {
                html += `<div class="carousel" id="game-carousel">
                    <div class="carousel-inner" id="carousel-inner"></div>
                    <button class="carousel-btn carousel-btn-left" onclick="carouselPrev(event)">‹</button>
                    <button class="carousel-btn carousel-btn-right" onclick="carouselNext(event)">›</button>
                    <div class="carousel-dots" id="carousel-dots"></div>
                </div>`;
            } else if (carouselImages.length === 1) {
                html += `<img src="${esc(carouselImages[0])}" alt="${esc(game.title)}" style="max-width:100%;border-radius:var(--radius-md);margin-bottom:1.5rem;">`;
            }

            html += `<p style="color: var(--text-secondary); margin-bottom: 1.5rem; white-space: pre-line;">${esc(game.description)}</p>`;
            if (game.tech && game.tech.length) {
                html += `<div style="margin-bottom: 1.5rem;">
                    <h4 style="margin-bottom: 0.5rem;">技术栈</h4>
                    <div class="card-tags">
                        ${game.tech.map(t => `<span class="card-tag">${esc(t)}</span>`).join('')}
                    </div>
                </div>`;
            }
            if (game.link) {
                html += `<a href="${esc(game.link)}" target="_blank" class="btn btn-primary">查看详情</a>`;
            }

            document.getElementById('modal-body').innerHTML = html;

            // Initialize carousel if multi-image
            if (carouselImages.length > 1) {
                renderCarousel();
                startCarouselAuto();
            }

            document.getElementById('game-modal').classList.add('active');
            document.body.style.overflow = 'hidden';
        }

        function renderCarousel() {
            const container = document.getElementById('carousel-inner');
            const dotsContainer = document.getElementById('carousel-dots');
            const len = carouselImages.length;
            if (!container || len === 0) return;

            const prevIdx = (carouselIndex - 1 + len) % len;
            const nextIdx = (carouselIndex + 1) % len;

            container.innerHTML = `
                <div class="carousel-slide prev" onclick="carouselPrev(event)">
                    <img src="${esc(carouselImages[prevIdx])}" alt="prev">
                </div>
                <div class="carousel-slide active">
                    <img src="${esc(carouselImages[carouselIndex])}" alt="active">
                </div>
                <div class="carousel-slide next" onclick="carouselNext(event)">
                    <img src="${esc(carouselImages[nextIdx])}" alt="next">
                </div>
            `;

            dotsContainer.innerHTML = carouselImages.map((_, i) =>
                `<button class="carousel-dot ${i === carouselIndex ? 'active' : ''}" onclick="carouselGoTo(${i})"></button>`
            ).join('');
        }

        function carouselGoTo(idx) {
            stopCarouselAuto();
            carouselIndex = ((idx % carouselImages.length) + carouselImages.length) % carouselImages.length;
            renderCarousel();
            startCarouselAuto();
        }

        function carouselNext(e) {
            if (e) e.stopPropagation();
            stopCarouselAuto();
            carouselIndex = (carouselIndex + 1) % carouselImages.length;
            renderCarousel();
            startCarouselAuto();
        }

        function carouselPrev(e) {
            if (e) e.stopPropagation();
            stopCarouselAuto();
            carouselIndex = (carouselIndex - 1 + carouselImages.length) % carouselImages.length;
            renderCarousel();
            startCarouselAuto();
        }

        function startCarouselAuto() {
            stopCarouselAuto();
            carouselTimer = setInterval(() => {
                carouselIndex = (carouselIndex + 1) % carouselImages.length;
                renderCarousel();
            }, 10000);
        }

        function stopCarouselAuto() {
            if (carouselTimer) {
                clearInterval(carouselTimer);
                carouselTimer = null;
            }
        }

        function closeModal(e, force = false) {
            if (force || e.target.id === 'game-modal') {
                stopCarouselAuto();
                document.getElementById('game-modal').classList.remove('active');
                document.body.style.overflow = '';
            }
        }

        document.addEventListener('keydown', e => {
            if (e.key === 'Escape') closeModal(null, true);
        });

        loadData();
    