
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
            document.getElementById('nav-logo').textContent = 'Online Resume';
            document.getElementById('hero-title').innerHTML = `您好，我是 <span>${p.name || ''}</span>`;
            document.getElementById('hero-subtitle').textContent = p.subtitle || '';
            document.getElementById('footer-name').textContent = p.name || '';

            // 简历 PDF 下载按钮：地址由后台配置，没配就不显示
            const heroActions = document.getElementById('hero-actions');
            if (p.resumePdf) {
                document.getElementById('resume-download').href = p.resumePdf;
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
                            ${title ? `<div class="about-card-title">${title}</div>` : ''}
                            <p class="about-card-text">${body}</p>
                        </div>
                    </div>`;
            }).join('');

            // Job Target
            const t = r.target || {};
            const jobTargetEl = document.getElementById('job-target');
            if (t.position || t.city || t.salary) {
                jobTargetEl.innerHTML = `
                    <div class="job-target-label">求职意向</div>
                    <div class="job-target-value">${t.position || ''}</div>
                    <div class="job-target-meta">
                        ${t.city ? `<span class="job-target-meta-item">📍 ${t.city}</span>` : ''}
                        ${t.salary ? `<span class="job-target-meta-item">💰 ${t.salary}</span>` : ''}
                        ${t.type ? `<span class="job-target-meta-item">⏰ ${t.type}</span>` : ''}
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
                    <h4>${cat}</h4>
                    <div class="skill-tags">
                        ${tags.map(item => `<span class="skill-tag">${item}</span>`).join('')}
                    </div>
                    ${note ? `<p class="skill-note">${note}</p>` : ''}
                </div>`;
            }).join('');
            document.getElementById('skills-grid').innerHTML = skillsHtml;

            // Games
            const games = siteData.games || [];
            document.getElementById('games-grid').innerHTML = games.map((game, i) => `
                <div class="card" onclick="openGame(${i})">
                    <div class="card-icon">${game.icon || '🎮'}</div>
                    <h3 class="card-title">${game.title}</h3>
                    <p class="card-desc">${game.description}</p>
                    <div class="card-tags">
                        ${(game.tech || []).map(t => `<span class="card-tag">${t}</span>`).join('')}
                    </div>
                </div>
            `).join('');

            // Videos
            const videos = siteData.videos || [];
            if (videos.length > 0) {
                document.getElementById('videos-grid').innerHTML = videos.map((video, i) => {
                    const bvid = video.bvid || (video.url || '').match(/BV[a-zA-Z0-9]+/)?.[0] || '';
                    const embedUrl = bvid ? `https://player.bilibili.com/player.html?bvid=${bvid}&page=1` : '';
                    if (!embedUrl) return '';
                    return `
                        <div class="video-card" style="cursor:default">
                            <iframe src="${embedUrl}" allowfullscreen style="width:100%;aspect-ratio:16/9;border:none;border-radius:var(--radius-md) var(--radius-md) 0 0;"></iframe>
                            <div class="video-info">
                                <h3 class="video-title">${video.title}</h3>
                                ${video.description ? `<p class="video-desc">${video.description}</p>` : ''}
                            </div>
                        </div>
                    `;
                }).join('');
            } else {
                document.getElementById('videos-grid').innerHTML = '<p style="color: var(--text-tertiary); text-align: center; grid-column: 1/-1;">暂无视频</p>';
            }

            // Footer Socials
            document.getElementById('footer-social').innerHTML = (p.socialLinks || []).map(link => {
                const displayVal = link.url.replace(/^mailto:/, '').replace(/^tel:/, '');
                return `<div class="social-item" onclick="toggleSocial(this)">
                    <span class="social-name">${link.name}</span>
                    <span class="social-reveal"><span class="social-value">${displayVal}</span></span>
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

        // Modal Logic
        function openVideo(index) {
            const video = siteData.videos[index];
            if (!video) return;
            document.getElementById('video-modal-title').textContent = video.title;
            const bvid = video.bvid || video.url?.match(/BV[a-zA-Z0-9]+/)?.[0] || '';
            const embedUrl = bvid ? `https://player.bilibili.com/player.html?bvid=${bvid}&page=1` : '';
            let html = '';
            if (embedUrl) {
                html += `<iframe src="${embedUrl}" allowfullscreen style="width:100%;aspect-ratio:16/9;border:none;border-radius:var(--radius-md);margin-bottom:1rem;"></iframe>`;
            }
            if (video.description) {
                html += `<p style="color:var(--text-secondary);white-space:pre-line;">${video.description}</p>`;
            }
            document.getElementById('video-modal-body').innerHTML = html;
            document.getElementById('video-modal').classList.add('active');
            document.body.style.overflow = 'hidden';
        }

        function closeVideoModal(e, force = false) {
            if (force || !e || e.target.id === 'video-modal') {
                document.getElementById('video-modal').classList.remove('active');
                document.body.style.overflow = '';
            }
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
                html += `<img src="${carouselImages[0]}" alt="${game.title}" style="max-width:100%;border-radius:var(--radius-md);margin-bottom:1.5rem;">`;
            }

            html += `<p style="color: var(--text-secondary); margin-bottom: 1.5rem; white-space: pre-line;">${game.description}</p>`;
            if (game.tech && game.tech.length) {
                html += `<div style="margin-bottom: 1.5rem;">
                    <h4 style="margin-bottom: 0.5rem;">技术栈</h4>
                    <div class="card-tags">
                        ${game.tech.map(t => `<span class="card-tag">${t}</span>`).join('')}
                    </div>
                </div>`;
            }
            if (game.link) {
                html += `<a href="${game.link}" target="_blank" class="btn btn-primary">查看详情</a>`;
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
                    <img src="${carouselImages[prevIdx]}" alt="prev">
                </div>
                <div class="carousel-slide active">
                    <img src="${carouselImages[carouselIndex]}" alt="active">
                </div>
                <div class="carousel-slide next" onclick="carouselNext(event)">
                    <img src="${carouselImages[nextIdx]}" alt="next">
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
            if (e.key === 'Escape') {
                closeModal(null, true);
                closeVideoModal(null, true);
            }
        });

        loadData();
    