
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
        const savedTheme = localStorage.getItem('theme') || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
        document.documentElement.setAttribute('data-theme', savedTheme);
        updateThemeIcon(savedTheme === 'dark');

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

            // Hero
            document.title = p.name ? `${p.name} · 个人简历` : '个人简历 · 作品集';
            document.getElementById('hero-title').innerHTML = `您好，我是 <span>${esc(p.name)}</span>`;
            document.getElementById('hero-subtitle').textContent = p.subtitle || '';
            document.getElementById('footer-name').textContent = p.name || '';

            // 简历 PDF 下载按钮：地址由后台配置，没配就不显示
            const heroActions = document.getElementById('hero-actions');
            const dlBtn = document.getElementById('resume-download');
            if (p.resumePdf) {
                dlBtn.href = p.resumePdf;
                // 上传的文件名是时间戳（如 1790081750725-24cb6336.pdf），
                // 不覆盖的话访客下到手的就是这串数字。download 属性只在同源时生效，
                // 简历正好是同源的 ./uploads/xxx.pdf。
                const who = (p.name || '').replace(/[\\/:*?"<>|]/g, '').trim();
                dlBtn.setAttribute('download', who ? `${who}-简历.pdf` : '简历.pdf');
                heroActions.style.display = '';
            } else {
                heroActions.style.display = 'none';
            }

            // About —— 每段写成「标题：内容」就渲染成一张卡片，没有冒号的按普通段落处理
            const ABOUT_ICONS = { '教育背景': '🎓', '最新项目': '⚡', '在校经历': '🧪' };
            document.getElementById('about-cards').innerHTML = (p.about || []).map(text => {
                // 只认开头 2-8 个字、且不含其他标点的「短标题：」，避免误切正常句子里的冒号
                const m = text.match(/^([^：:，。；]{2,8})[：:]\s*([\s\S]+)$/);
                const title = m ? m[1].trim() : '';
                const body = m ? m[2] : text;
                return `
                    <div class="about-card">
                        ${title ? `<div class="about-card-icon">${ABOUT_ICONS[title] || '📌'}</div>` : ''}
                        <div class="about-card-body">
                            ${title ? `<div class="about-card-title">${esc(title)}</div>` : ''}
                            <p class="about-card-text">${esc(body)}</p>
                        </div>
                    </div>`;
            }).join('');

            // Job Target
            const t = r.target || {};
            const jobTargetEl = document.getElementById('job-target');
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
                jobTargetEl.style.display = 'block';
            } else {
                jobTargetEl.style.display = 'none';
            }

            const skillsHtml = Object.entries(p.skills || {}).map(([cat, val]) => {
                // 新格式是 { tags, note }；旧的纯数组格式也认，免得老 data.json 渲染不出来
                const tags = Array.isArray(val) ? val : (val.tags || []);
                const note = Array.isArray(val) ? '' : (val.note || '');
                return `
                <div class="skill-card">
                    <h4>${esc(cat)}</h4>
                    <div class="skill-tags">
                        ${tags.map(item => `<span class="skill-tag">${esc(item)}</span>`).join('')}
                    </div>
                    ${note ? `<p class="skill-note">${esc(note)}</p>` : ''}
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

            // Footer Socials
            document.getElementById('footer-social').innerHTML = (p.socialLinks || []).map(link => {
                // url 可能缺失（手填的 data.json 里漏一个字段），别让它把整个渲染打断
                const displayVal = (link.url || '').replace(/^mailto:/, '').replace(/^tel:/, '');
                return `<div class="social-item" onclick="toggleSocial(this)">
                    <span class="social-name">${esc(link.name)}</span>
                    <span class="social-reveal"><span class="social-value">${esc(displayVal)}</span></span>
                </div>`;
            }).join('');
        }

        function toggleSocial(el) {
            // 展开动画由 .social-item.open 驱动（见 style.css），
            // 所以状态挂在 item 上，value 只负责显示内容
            const wasOpen = el.classList.contains('open');
            document.querySelectorAll('.social-item.open').forEach(item => item.classList.remove('open'));
            el.classList.toggle('open', !wasOpen);
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
    