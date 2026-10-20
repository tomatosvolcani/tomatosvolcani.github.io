// js/experiment-ai.js
// UI/controller for the AI-assisted experiment import flow.
// The Gemini API key is never exposed here; all model calls go through the backend.

const DEFAULT_API_URL = '/api/ai/parse-experiment';
// Cost limits. backend/inputs.py enforces the same numbers — that is the real
// boundary; these only fail fast in the browser. Keep the two in sync.
const MAX_IMAGES = 12;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_CLOUD_IMAGE_BYTES = 27 * 1024 * 1024;
// Cloud Run rejects a request body above 32MB; leave room for the form fields.
const MAX_CLOUD_UPLOAD_BYTES = 30 * 1024 * 1024;
const MAX_TABLE_FILES = 3;
const MAX_TABLE_FILE_BYTES = 2 * 1024 * 1024;
const MAX_USER_TEXT_CHARS = 20000;
const ACCEPTED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);
const IMAGE_ACCEPT = 'image/jpeg,image/png,image/webp,image/heic,image/heif';
const TABLE_EXTENSIONS = ['.csv', '.xlsx'];
const TABLE_ACCEPT = '.csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const MODEL_CAPACITY_MESSAGE = 'יש כרגע עומס על המודל או שמכסת הקריאות החינמית הסתיימה. נסו לבחור מודל אחר או לנסות שוב מאוחר יותר.';

export class ExperimentAIController {
    constructor(options) {
        this.options = options;
        // תמונות וטבלאות נשמרות בנפרד: רק התמונות עוברות את מסך היישור/סיבוב.
        this.files = [];
        this.tableFiles = [];
        this.isBusy = false;
        this.hasAppliedDraft = false;
        this.lastResult = null;
        // מפת סיבוב לכל תמונה (מעלות: 0/90/180/270) + מצב מסך היישור
        this.rotations = new WeakMap();
        this.reviewIndex = 0;
    }

    init() {
        this.button = document.getElementById('btn-ai-mode');
        this.drawer = document.getElementById('ai-experiment-drawer');
        this.backdrop = document.getElementById('ai-experiment-backdrop');
        this.closeButton = document.getElementById('ai-drawer-close');
        this.collapseButton = document.getElementById('ai-drawer-collapse');
        this.fileInput = document.getElementById('ai-image-input');
        this.dropzone = document.getElementById('ai-image-dropzone');
        this.dropzoneTitle = document.getElementById('ai-dropzone-title');
        this.dropzoneHint = document.getElementById('ai-dropzone-hint');
        this.fileList = document.getElementById('ai-selected-files');
        this.userText = document.getElementById('ai-source-text');
        this.modelSelect = document.getElementById('ai-model-select');
        this.overwriteCheckbox = document.getElementById('ai-overwrite-existing');
        this.analyzeButton = document.getElementById('ai-analyze-button');
        this.status = document.getElementById('ai-analysis-status');
        this.results = document.getElementById('ai-analysis-results');
        this.reviewBar = document.getElementById('ai-review-bar');
        this.reviewSummary = document.getElementById('ai-review-summary');
        this.savePageButton = document.getElementById('ai-save-current-page');
        this.saveAllButton = document.getElementById('ai-save-all');
        this.cancelButton = document.getElementById('ai-cancel-draft');

        if (!this.button || !this.drawer) return;

        this.applySourceMode();

        // Keep the assistant as a regular item in the right sidebar.
        this.button.classList.remove('ai-floating-button');
        this.setupFixedTab();
        this.button.addEventListener('click', (event) => {
            event.preventDefault();
            if (this.button.dataset.dragMoved === 'true') return;
            if (this.drawer.classList.contains('open')) this.requestClose();
            else this.open();
        });
        this.closeButton?.addEventListener('click', () => this.requestClose());
        this.collapseButton?.addEventListener('click', () => this.requestClose());
        this.backdrop?.addEventListener('click', () => this.requestClose());
        this.fileInput?.addEventListener('change', () => this.addFiles(this.fileInput.files));
        this.dropzone?.addEventListener('click', () => this.fileInput?.click());
        this.dropzone?.addEventListener('dragover', (event) => {
            event.preventDefault();
            this.dropzone.classList.add('dragging');
        });
        this.dropzone?.addEventListener('dragleave', () => this.dropzone.classList.remove('dragging'));
        this.dropzone?.addEventListener('drop', (event) => {
            event.preventDefault();
            this.dropzone.classList.remove('dragging');
            this.addFiles(event.dataTransfer?.files || []);
        });
        this.analyzeButton?.addEventListener('click', () => this.onAnalyzeClick());
        this.savePageButton?.addEventListener('click', async () => {
            this.setBusy(true, 'שומר את העמוד הנוכחי...');
            try {
                const saved = await this.options.saveCurrentPage?.();
                if (saved) this.updateReviewSummary();
            } finally {
                this.setBusy(false);
            }
        });
        this.saveAllButton?.addEventListener('click', async () => {
            this.setBusy(true, 'שומר את כל השינויים...');
            try {
                const saved = await this.options.saveAll?.();
                if (saved) {
                    this.hasAppliedDraft = false;
                    this.close(true);
                }
            } finally {
                this.setBusy(false);
            }
        });
        this.cancelButton?.addEventListener('click', () => this.options.cancelDraft?.());
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && this.drawer.classList.contains('open')) this.requestClose();
        });
    }

    imagesAllowed() {
        return Boolean(this.options.allowImages?.());
    }

    // Image analysis is opt-in per user (users/{uid}.allowAIImages === true);
    // CSV/XLSX and free text are open to everyone with AI access. The server
    // enforces the same split — this only adapts the drop zone.
    applySourceMode() {
        const images = this.imagesAllowed();
        const tableSize = formatBytes(MAX_TABLE_FILE_BYTES);
        if (this.fileInput) this.fileInput.accept = images ? `${IMAGE_ACCEPT},${TABLE_ACCEPT}` : TABLE_ACCEPT;
        if (this.dropzoneTitle) {
            this.dropzoneTitle.textContent = images
                ? 'גררו תמונות או קובצי CSV / Excel לכאן או לחצו לבחירה'
                : 'גררו קובצי CSV / Excel לכאן או לחצו לבחירה';
        }
        if (this.dropzoneHint) {
            this.dropzoneHint.textContent = images
                ? `עד ${MAX_IMAGES} תמונות (JPG, PNG, WEBP, HEIC) ועד ${MAX_TABLE_FILES} טבלאות CSV / XLSX של עד ${tableSize}`
                : `עד ${MAX_TABLE_FILES} קבצים מסוג CSV או XLSX, עד ${tableSize} לקובץ`;
        }
        if (!images && this.files.length) {
            this.files = [];
            this.renderFiles();
        }
    }

    setupFixedTab() {
        const button = this.button.cloneNode(true);
        button.id = 'btn-ai-mode-fixed';
        button.className = 'ai-fixed-tab';
        button.setAttribute('role', 'button');
        button.setAttribute('aria-controls', 'ai-experiment-drawer');
        button.setAttribute('aria-haspopup', 'dialog');
        button.setAttribute('aria-expanded', 'false');
        button.setAttribute('aria-label', 'פתיחת עוזר AI');
        button.title = 'פתיחת עוזר AI';
        document.body.appendChild(button);
        this.fixedTabButton = button;

        button.addEventListener('click', (event) => {
            event.preventDefault();
            if (this.drawer.classList.contains('open')) this.requestClose();
            else this.open();
        });
    }

    setupFloatingButton() {
        // Keep the original item in the sidebar and create a separate floating copy.
        const button = this.button.cloneNode(true);
        button.id = 'btn-ai-mode-floating';
        button.classList.add('ai-floating-button');
        button.classList.remove('nav-item', 'ai-nav-item');
        button.setAttribute('role', 'button');
        button.setAttribute('aria-controls', 'ai-experiment-drawer');
        button.setAttribute('aria-haspopup', 'dialog');
        button.setAttribute('aria-expanded', 'false');
        button.setAttribute('aria-label', 'פתיחת עוזר ה-AI של מערכת איגום - ח״ץ. ניתן לגרור את הכפתור.');
        button.title = 'עוזר ה-AI של מערכת איגום - ח״ץ · לחיצה לפתיחה · גרירה לשינוי מיקום';
        document.body.appendChild(button);

        button.addEventListener('click', (event) => {
            event.preventDefault();
            if (button.dataset.dragMoved === 'true') return;
            if (this.drawer.classList.contains('open')) this.requestClose();
            else this.open();
        });

        const storageKey = 'experiment-ai-floating-position-v3';
        const dragThreshold = 5;
        let isDragging = false;
        let hasMoved = false;
        let startX = 0;
        let startY = 0;
        let originalLeft = 0;
        let originalBottom = 0;
        let pendingFrame = 0;
        let lastPointerX = 0;
        let lastPointerY = 0;

        const clampPosition = (left, bottom) => {
            const rect = button.getBoundingClientRect();
            return {
                left: Math.max(0, Math.min(left, Math.max(0, window.innerWidth - rect.width))),
                bottom: Math.max(0, Math.min(bottom, Math.max(0, window.innerHeight - rect.height))),
            };
        };

        const applyPosition = (left, bottom) => {
            const position = clampPosition(left, bottom);
            button.style.left = `${position.left}px`;
            button.style.bottom = `${position.bottom}px`;
            button.style.right = 'auto';
            button.style.top = 'auto';
        };

        const placeInitial = (attempt = 0) => {
            try {
                const saved = JSON.parse(localStorage.getItem(storageKey) || 'null');
                if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.bottom)) {
                    applyPosition(saved.left, saved.bottom);
                    return;
                }
            } catch { /* localStorage optional */ }

            const mapWidget = document.querySelector('.research-map-widget');
            if (mapWidget) {
                const mapRect = mapWidget.getBoundingClientRect();
                const mapBottom = window.innerHeight - mapRect.bottom;
                applyPosition(mapRect.left, mapBottom + mapRect.height + 10);
                return;
            }
            if (attempt < 40) setTimeout(() => placeInitial(attempt + 1), 100);
            else applyPosition(24, 208);
        };
        requestAnimationFrame(() => placeInitial());

        const drawDragFrame = () => {
            pendingFrame = 0;
            if (!isDragging || !hasMoved) return;
            const dx = lastPointerX - startX;
            const dy = lastPointerY - startY;
            applyPosition(originalLeft + dx, originalBottom - dy);
        };

        const onPointerMove = (event) => {
            if (!isDragging) return;
            lastPointerX = event.clientX;
            lastPointerY = event.clientY;
            const dx = lastPointerX - startX;
            const dy = lastPointerY - startY;
            if (!hasMoved && Math.hypot(dx, dy) < dragThreshold) return;
            hasMoved = true;
            button.classList.add('dragging');
            event.preventDefault();
            if (!pendingFrame) pendingFrame = requestAnimationFrame(drawDragFrame);
        };

        const finishDrag = () => {
            if (!isDragging) return;
            isDragging = false;
            document.removeEventListener('pointermove', onPointerMove);
            document.removeEventListener('pointerup', finishDrag);
            document.removeEventListener('pointercancel', finishDrag);
            if (pendingFrame) {
                cancelAnimationFrame(pendingFrame);
                pendingFrame = 0;
                drawDragFrame();
            }
            button.classList.remove('dragging');
            button.dataset.dragMoved = hasMoved ? 'true' : 'false';
            if (hasMoved) {
                const rect = button.getBoundingClientRect();
                try {
                    localStorage.setItem(storageKey, JSON.stringify({
                        left: rect.left,
                        bottom: window.innerHeight - rect.bottom,
                    }));
                } catch { /* localStorage optional */ }
                setTimeout(() => { button.dataset.dragMoved = 'false'; }, 0);
            }
        };

        button.addEventListener('pointerdown', (event) => {
            if (event.button !== undefined && event.button !== 0) return;
            const rect = button.getBoundingClientRect();
            originalLeft = rect.left;
            originalBottom = window.innerHeight - rect.bottom;
            startX = lastPointerX = event.clientX;
            startY = lastPointerY = event.clientY;
            hasMoved = false;
            isDragging = true;
            button.dataset.dragMoved = 'false';
            document.addEventListener('pointermove', onPointerMove, { passive: false });
            document.addEventListener('pointerup', finishDrag);
            document.addEventListener('pointercancel', finishDrag);
        });

        window.addEventListener('resize', () => {
            const rect = button.getBoundingClientRect();
            applyPosition(rect.left, window.innerHeight - rect.bottom);
        });
    }

    open() {
        if (!this.options.canEdit?.()) {
            this.options.notify?.('אין הרשאת עריכה לניסוי זה', 'error');
            return;
        }
        this.options.enterMode?.();
        this.drawer.classList.add('open');
        this.drawer.setAttribute('aria-hidden', 'false');
        this.button.classList.add('active');
        this.button.setAttribute('aria-expanded', 'true');
        this.fixedTabButton?.classList.add('active');
        this.fixedTabButton?.setAttribute('aria-expanded', 'true');
        this.backdrop?.classList.add('open');
        document.body.classList.add('ai-drawer-open');
        this.userText?.focus();
    }

    requestClose() {
        if (this.isBusy) return;
        // סגירת החלונית אינה ביטול הטיוטה. אם קיימת טיוטה, משאירים
        // את מצב הסקירה פעיל ואת כל השדות שהוזנו ללא שינוי.
        this.close(this.hasAppliedDraft);
    }

    close(keepMode = false) {
        this.drawer.classList.remove('open');
        this.drawer.setAttribute('aria-hidden', 'true');
        this.button.classList.remove('active');
        this.button.setAttribute('aria-expanded', 'false');
        this.fixedTabButton?.classList.remove('active');
        this.fixedTabButton?.setAttribute('aria-expanded', 'false');
        this.backdrop?.classList.remove('open');
        document.body.classList.remove('ai-drawer-open');
        if (!keepMode) this.options.exitMode?.();
    }

    addFiles(fileList) {
        const incoming = Array.from(fileList || []);
        const imagesAllowed = this.imagesAllowed();
        const notify = (message) => this.options.notify?.(message, 'warning');
        for (const file of incoming) {
            const kind = classifySourceFile(file);
            if (kind === 'image') {
                if (!imagesAllowed) {
                    notify(`ניתוח תמונות אינו פעיל עבור המשתמש שלך. ניתן לצרף קובצי CSV או XLSX.`);
                    continue;
                }
                if (this.files.length >= MAX_IMAGES) {
                    notify(`ניתן לצרף עד ${MAX_IMAGES} תמונות בכל קריאה`);
                    continue;
                }
                if (file.size > MAX_IMAGE_BYTES) {
                    notify(`הקובץ ${file.name} גדול מ-10MB`);
                    continue;
                }
                if (!hasFile(this.files, file)) {
                    this.files.push(file);
                    this.rotations.set(file, 0);
                }
            } else if (kind === 'table') {
                if (this.tableFiles.length >= MAX_TABLE_FILES) {
                    notify(`ניתן לצרף עד ${MAX_TABLE_FILES} קובצי CSV / XLSX בכל קריאה`);
                    continue;
                }
                if (file.size > MAX_TABLE_FILE_BYTES) {
                    notify(`הקובץ ${file.name} גדול מ-${formatBytes(MAX_TABLE_FILE_BYTES)}. כדי לשמור על עלות הניתוח, השאירו בקובץ רק את הנתונים הרלוונטיים לניסוי.`);
                    continue;
                }
                if (!file.size) {
                    notify(`הקובץ ${file.name} ריק`);
                    continue;
                }
                if (!hasFile(this.tableFiles, file)) this.tableFiles.push(file);
            } else if (kind === 'legacy-excel') {
                notify(`הקובץ ${file.name} בפורמט Excel ישן (.xls). שמרו אותו כ-.xlsx ונסו שוב.`);
            } else {
                notify(imagesAllowed
                    ? `הקובץ ${file.name} אינו נתמך. ניתן לצרף תמונות או קובצי CSV / XLSX.`
                    : `הקובץ ${file.name} אינו נתמך. ניתן לצרף קובצי CSV או XLSX.`);
            }
        }
        if (this.fileInput) this.fileInput.value = '';
        this.renderFiles();
    }

    renderFiles() {
        if (!this.fileList) return;
        const entries = [
            ...this.files.map((file, index) => ({ file, index, kind: 'image', icon: 'fa-image', label: 'הסר תמונה' })),
            ...this.tableFiles.map((file, index) => ({
                file,
                index,
                kind: 'table',
                icon: file.name.toLowerCase().endsWith('.csv') ? 'fa-file-csv' : 'fa-file-excel',
                label: 'הסר קובץ'
            }))
        ];
        if (!entries.length) {
            this.fileList.innerHTML = '<div class="ai-empty-files">לא נבחרו קבצים</div>';
            return;
        }
        this.fileList.innerHTML = entries.map(({ file, index, kind, icon, label }) => `
            <div class="ai-file-chip">
                <i class="fas ${icon}"></i>
                <span title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</span>
                <small>${formatBytes(file.size)}</small>
                <button type="button" data-remove-ai-file="${kind}:${index}" aria-label="${label}"><i class="fas fa-xmark"></i></button>
            </div>
        `).join('');
        this.fileList.querySelectorAll('[data-remove-ai-file]').forEach((button) => {
            button.addEventListener('click', () => {
                const [kind, index] = button.dataset.removeAiFile.split(':');
                (kind === 'table' ? this.tableFiles : this.files).splice(Number(index), 1);
                this.renderFiles();
            });
        });
    }

    // ─────────────────────────────────────────────────────────────
    // זרימת יישור/סיבוב תמונות לפני הניתוח
    // ─────────────────────────────────────────────────────────────
    onAnalyzeClick() {
        const text = this.userText?.value.trim() || '';
        if (!this.validateSources(text)) return;
        // אם יש תמונות — פותחים קודם מסך יישור/סיבוב; אחרת מנתחים ישר
        if (this.files.length) {
            this.openImageReview();
        } else {
            this.analyze();
        }
    }

    validateSources(text) {
        if (!this.files.length && !this.tableFiles.length && !text) {
            this.options.notify?.('יש לצרף לפחות קובץ אחד או להזין טקסט', 'warning');
            return false;
        }
        if (text.length > MAX_USER_TEXT_CHARS) {
            this.options.notify?.(
                `הטקסט ארוך מדי (${text.length.toLocaleString()} תווים). המגבלה היא ${MAX_USER_TEXT_CHARS.toLocaleString()} תווים — קצרו אותו או צרפו את הנתונים כקובץ CSV / XLSX.`,
                'warning'
            );
            return false;
        }
        return true;
    }

    openImageReview() {
        this.reviewIndex = 0;
        this._buildImageReviewModal();
        this._renderReviewImage();
        requestAnimationFrame(() => this._imgReviewOverlay?.classList.add('show'));
    }

    _closeImageReview() {
        this._imgReviewOverlay?.classList.remove('show');
        setTimeout(() => {
            this._imgReviewOverlay?.remove();
            this._imgReviewOverlay = null;
        }, 250);
    }

    _buildImageReviewModal() {
        if (this._imgReviewOverlay) this._imgReviewOverlay.remove();
        const overlay = document.createElement('div');
        overlay.className = 'ai-rotate-overlay';
        overlay.innerHTML = `
            <div class="ai-rotate-card">
                <div class="ai-rotate-head">
                    <h3><i class="fas fa-crop-simple"></i> יישור התמונות לפני ניתוח</h3>
                    <button type="button" class="ai-rotate-x" aria-label="סגור"><i class="fas fa-xmark"></i></button>
                </div>
                <p class="ai-rotate-hint">
                    סובב/י כל תמונה כך שהטקסט יהיה <b>ישר וקריא</b>. זה משפר משמעותית את דיוק ה-AI.
                    לאחר מכן המשך/י לתמונה הבאה.
                </p>
                <div class="ai-rotate-stage">
                    <img class="ai-rotate-img" alt="תצוגה מקדימה" />
                </div>
                <div class="ai-rotate-counter"></div>
                <div class="ai-rotate-tools">
                    <button type="button" class="ai-rotate-btn" data-act="left"><i class="fas fa-rotate-left"></i> סובב שמאלה</button>
                    <button type="button" class="ai-rotate-btn" data-act="right"><i class="fas fa-rotate-right"></i> סובב ימינה</button>
                </div>
                <div class="ai-rotate-nav">
                    <button type="button" class="ai-nav-btn ghost" data-act="prev"><i class="fas fa-chevron-right"></i> הקודם</button>
                    <button type="button" class="ai-nav-btn primary" data-act="next">הבא <i class="fas fa-chevron-left"></i></button>
                </div>
            </div>`;
        document.body.appendChild(overlay);
        this._imgReviewOverlay = overlay;
        this._imgReviewImg = overlay.querySelector('.ai-rotate-img');

        overlay.querySelector('.ai-rotate-x').addEventListener('click', () => this._closeImageReview());
        overlay.querySelectorAll('[data-act]').forEach((btn) => {
            btn.addEventListener('click', () => this._handleReviewAction(btn.dataset.act));
        });
    }

    _handleReviewAction(act) {
        const file = this.files[this.reviewIndex];
        if (act === 'left' || act === 'right') {
            const cur = this.rotations.get(file) || 0;
            const delta = act === 'right' ? 90 : -90;
            this.rotations.set(file, (cur + delta + 360) % 360);
            this._applyPreviewRotation();
            return;
        }
        if (act === 'prev') {
            if (this.reviewIndex > 0) {
                this.reviewIndex -= 1;
                this._renderReviewImage();
            }
            return;
        }
        if (act === 'next') {
            if (this.reviewIndex < this.files.length - 1) {
                this.reviewIndex += 1;
                this._renderReviewImage();
            } else {
                // תמונה אחרונה → שליחה לניתוח
                this._finishReviewAndAnalyze();
            }
        }
    }

    _renderReviewImage() {
        const file = this.files[this.reviewIndex];
        if (!file || !this._imgReviewImg) return;
        if (this._previewUrl) URL.revokeObjectURL(this._previewUrl);
        this._previewUrl = URL.createObjectURL(file);
        this._imgReviewImg.src = this._previewUrl;
        this._applyPreviewRotation();

        const counter = this._imgReviewOverlay.querySelector('.ai-rotate-counter');
        if (counter) counter.textContent = `תמונה ${this.reviewIndex + 1} מתוך ${this.files.length}`;

        const nextBtn = this._imgReviewOverlay.querySelector('[data-act="next"]');
        const prevBtn = this._imgReviewOverlay.querySelector('[data-act="prev"]');
        if (prevBtn) prevBtn.disabled = this.reviewIndex === 0;
        if (nextBtn) {
            const isLast = this.reviewIndex === this.files.length - 1;
            nextBtn.innerHTML = isLast
                ? '<i class="fas fa-wand-magic-sparkles"></i> שלח לניתוח'
                : 'הבא <i class="fas fa-chevron-left"></i>';
            nextBtn.classList.toggle('send', isLast);
        }
    }

    _applyPreviewRotation() {
        const file = this.files[this.reviewIndex];
        const deg = this.rotations.get(file) || 0;
        if (this._imgReviewImg) this._imgReviewImg.style.transform = `rotate(${deg}deg)`;
    }

    async _finishReviewAndAnalyze() {
        this._closeImageReview();
        if (this._previewUrl) { URL.revokeObjectURL(this._previewUrl); this._previewUrl = null; }
        // מחיל את הסיבובים בפועל על נתוני התמונה לפני שליחה ל-LLM
        try {
            const rotated = [];
            for (const file of this.files) {
                const deg = this.rotations.get(file) || 0;
                rotated.push(deg ? await rotateImageFile(file, deg) : file);
            }
            this.files = rotated;
            this.files.forEach((f) => this.rotations.set(f, 0));
            this.renderFiles();
        } catch (err) {
            console.warn('Image rotation failed, sending originals:', err);
        }
        this.analyze();
    }

    async analyze() {
        const text = this.userText?.value.trim() || '';
        if (!this.validateSources(text)) return;

        const selectedModel = this.modelSelect?.value || 'gemini-3.8-flash';
        this.setBusy(true, `${selectedModel} קורא את המקורות וממפה אותם לשדות...`);
        this.results?.classList.add('hidden');

        try {
            const context = await this.options.buildContext?.({
                allowOverwriteExisting: Boolean(this.overwriteCheckbox?.checked)
            });
            const formData = new FormData();
            // Cloud Functions דור 2 מגביל את גודל בקשת ה-HTTP. מכינים את כל
            // התמונות מקומית בלי לשנות את מספרן או את התוכן שהמשתמש צירף.
            const uploadFiles = await optimizeImagesForUpload(this.files, (done, total) => {
                this.setBusy(true, `מכין תמונות לניתוח (${done}/${total})...`);
            });
            const totalImageBytes = uploadFiles.reduce((sum, file) => sum + file.size, 0);
            if (totalImageBytes > MAX_CLOUD_IMAGE_BYTES) {
                throw new Error('המשקל הכולל של התמונות גדול מדי לשליחה. נסו להסיר תמונה או להשתמש בתמונות קטנות יותר.');
            }
            const totalTableBytes = this.tableFiles.reduce((sum, file) => sum + file.size, 0);
            if (totalImageBytes + totalTableBytes > MAX_CLOUD_UPLOAD_BYTES) {
                throw new Error('המשקל הכולל של הקבצים גדול מדי לשליחה. נסו להסיר תמונה או קובץ.');
            }
            uploadFiles.forEach((file) => formData.append('images', file, file.name));
            // CSV/XLSX נשלחים כפי שהם; השרת ממיר אותם לטקסט ומגביל את הנפח שמגיע למודל.
            this.tableFiles.forEach((file) => formData.append('tables', file, file.name));
            formData.append('user_text', text);
            formData.append('model', selectedModel);
            formData.append('context_json', JSON.stringify(context));

            const headers = {};
            const token = await this.options.getAuthToken?.();
            if (token) headers.Authorization = `Bearer ${token}`;

            const response = await fetch(this.getApiUrl(), {
                method: 'POST',
                headers,
                body: formData
            });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok) {
                const requestError = new Error(payload.detail || payload.error || `HTTP ${response.status}`);
                requestError.code = payload.code || '';
                requestError.httpStatus = response.status;
                throw requestError;
            }

            this.lastResult = payload;
            const applied = await this.options.applyExtraction?.(payload, {
                allowOverwriteExisting: Boolean(this.overwriteCheckbox?.checked)
            });
            this.hasAppliedDraft = Boolean(applied?.appliedCount);
            this.renderResult(payload, applied);
            if (this.hasAppliedDraft) {
                this.reviewBar?.classList.remove('hidden');
                this.updateReviewSummary(applied);
                this.close(true);
                this.options.notify?.('טיוטת AI הוזנה. השמירה האוטומטית נשארת כבויה עד לאישור.', 'success');
            }
        } catch (error) {
            console.error('AI experiment import failed', error);
            const isCapacityError = error.code === 'MODEL_CAPACITY_OR_QUOTA'
                || error.httpStatus === 429
                || error.httpStatus === 503;
            const userMessage = isCapacityError
                ? MODEL_CAPACITY_MESSAGE
                : (error.message || 'שגיאה לא ידועה');
            this.status.innerHTML = `<i class="fas fa-triangle-exclamation"></i> ${escapeHtml(userMessage)}`;
            this.status.className = 'ai-analysis-status error';
            this.options.notify?.(`שגיאה בניתוח AI: ${userMessage}`, 'error');
        } finally {
            this.setBusy(false);
        }
    }

    getApiUrl() {
        return window.EXPERIMENT_AI_API_URL || localStorage.getItem('experiment-ai-api-url') || DEFAULT_API_URL;
    }

    renderResult(payload, applied = {}) {
        if (!this.results) return;
        const warnings = Array.isArray(payload.warnings) ? payload.warnings : [];
        const ignored = Array.isArray(payload.ignored_content) ? payload.ignored_content : [];
        const unresolved = Array.isArray(payload.unresolved_items) ? payload.unresolved_items : [];
        const rejected = Array.isArray(applied.rejected) ? applied.rejected : [];
        this.results.innerHTML = `
            <div class="ai-result-card">
                <h4><i class="fas fa-wand-magic-sparkles"></i> תוצאת הניתוח</h4>
                <p>${escapeHtml(payload.summary || 'הניתוח הסתיים.')}</p>
                ${payload.model_used ? `<p class="ai-result-model"><i class="fas fa-microchip"></i> ${escapeHtml(payload.model_used)}</p>` : ''}
                <div class="ai-result-metrics">
                    <span><strong>${Number(applied.appliedCount || 0)}</strong> ערכים הוזנו</span>
                    <span><strong>${Number(applied.skippedCount || 0)}</strong> דולגו</span>
                    <span><strong>${rejected.length}</strong> נדחו באימות</span>
                </div>
            </div>
            ${renderList('אזהרות', warnings, 'fa-triangle-exclamation')}
            ${renderList('פריטים לא חד-משמעיים', unresolved, 'fa-circle-question')}
            ${renderList('תוכן שהמערכת התעלמה ממנו', ignored, 'fa-filter-circle-xmark')}
            ${renderList('עדכונים שנדחו', rejected, 'fa-shield-halved')}
        `;
        this.results.classList.remove('hidden');
    }

    updateReviewSummary(applied) {
        if (!this.reviewSummary) return;
        const state = this.options.getReviewState?.() || {};
        const dirty = Array.isArray(state.dirtyViews) ? state.dirtyViews : [];
        const count = applied?.appliedCount ?? state.appliedCount ?? 0;
        this.reviewSummary.textContent = dirty.length
            ? `מצב סקירת AI: ${count} עדכונים, ${dirty.length} עמודים עדיין לא נשמרו.`
            : 'כל עמודי טיוטת ה-AI נשמרו.';
    }

    setBusy(isBusy, message = '') {
        this.isBusy = isBusy;
        if (this.analyzeButton) this.analyzeButton.disabled = isBusy;
        if (this.savePageButton) this.savePageButton.disabled = isBusy;
        if (this.saveAllButton) this.saveAllButton.disabled = isBusy;
        if (this.cancelButton) this.cancelButton.disabled = isBusy;
        if (this.status) {
            if (isBusy) {
                this.status.innerHTML = `<i class="fas fa-spinner fa-spin"></i> ${escapeHtml(message)}`;
                this.status.className = 'ai-analysis-status busy';
            } else if (!this.status.classList.contains('error')) {
                this.status.innerHTML = '';
                this.status.className = 'ai-analysis-status';
            }
        }
    }
}

function renderList(title, values, icon) {
    if (!values?.length) return '';
    const normalized = values.map((value) => typeof value === 'string' ? value : JSON.stringify(value));
    return `
        <details class="ai-result-details">
            <summary><i class="fas ${icon}"></i> ${escapeHtml(title)} (${normalized.length})</summary>
            <ul>${normalized.map((value) => `<li>${escapeHtml(value)}</li>`).join('')}</ul>
        </details>
    `;
}

// מכין תמונות יעילות לשליחה לענן: שומר פרטים לקריאת טקסט, אך מונע שליחת
// תמונות מצלמה של 8K/12K שמגדילות מאוד את זמן ההעלאה והעיבוד החזותי.
async function optimizeImagesForUpload(files, onProgress = () => {}) {
    const optimized = [];
    for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        try {
            optimized.push(await optimizeSingleImageForUpload(file));
        } catch (error) {
            console.warn(`AI image optimization skipped for ${file.name}:`, error);
            optimized.push(file);
        }
        onProgress(index + 1, files.length);
        // מאפשר ל-UI לצייר את התקדמות ההכנה בין תמונות.
        await new Promise(resolve => requestAnimationFrame(resolve));
    }
    return optimized;
}

async function optimizeSingleImageForUpload(file) {
    // HEIC/HEIF אינם נתמכים באופן עקבי ב-createImageBitmap; במקרה כזה נשמר המקור.
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) return file;
    const bitmap = await createImageBitmap(file);
    try {
        const maxEdge = 2048;
        const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
        const width = Math.max(1, Math.round(bitmap.width * scale));
        const height = Math.max(1, Math.round(bitmap.height * scale));

        // קובץ קטן שכבר נמצא ברזולוציה הנכונה אינו עובר דחיסה נוספת.
        if (scale === 1 && file.size <= 1_600_000) return file;

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d', { alpha: false });
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, height);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(bitmap, 0, 0, width, height);
        const blob = await new Promise((resolve, reject) => {
            canvas.toBlob(value => value ? resolve(value) : reject(new Error('Image encoding failed')), 'image/jpeg', 0.88);
        });
        const baseName = file.name.replace(/\.[^.]+$/, '') || 'image';
        return new File([blob], `${baseName}-ai.jpg`, { type: 'image/jpeg', lastModified: file.lastModified });
    } finally {
        bitmap.close?.();
    }
}

// מסובב קובץ תמונה ב-canvas ומחזיר File חדש (JPEG/PNG לפי המקור).
async function rotateImageFile(file, degrees) {
    const deg = ((degrees % 360) + 360) % 360;
    if (deg === 0) return file;
    const bitmap = await createImageBitmap(file);
    const swap = deg === 90 || deg === 270;
    const canvas = document.createElement('canvas');
    canvas.width = swap ? bitmap.height : bitmap.width;
    canvas.height = swap ? bitmap.width : bitmap.height;
    const ctx = canvas.getContext('2d');
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate((deg * Math.PI) / 180);
    ctx.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
    bitmap.close?.();

    const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
    const quality = type === 'image/jpeg' ? 0.92 : undefined;
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, type, quality));
    return new File([blob], file.name, { type, lastModified: Date.now() });
}

// סיווג לפי סוג MIME לתמונות, ולפי סיומת לטבלאות: דפדפנים מדווחים על CSV
// כ-text/csv, כ-application/vnd.ms-excel (כש-Excel מותקן) או בלי סוג בכלל.
function classifySourceFile(file) {
    const name = String(file.name || '').toLowerCase();
    if (ACCEPTED_IMAGE_TYPES.has(file.type)) return 'image';
    if (TABLE_EXTENSIONS.some((extension) => name.endsWith(extension))) return 'table';
    if (name.endsWith('.xls')) return 'legacy-excel';
    return 'unsupported';
}

function hasFile(list, file) {
    return list.some((existing) =>
        existing.name === file.name && existing.size === file.size && existing.lastModified === file.lastModified
    );
}

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}