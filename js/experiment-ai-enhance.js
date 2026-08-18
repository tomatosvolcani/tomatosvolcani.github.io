// js/experiment-ai-enhance.js
// ─────────────────────────────────────────────────────────────────────────
// שיפורי UX למצב ה-AI. מודול עצמאי, לא תלוי ב-experiment.js.
//
// מספק שלושה דברים:
//   1. AIThinking  — overlay עם shimmer וטקסט מתחלף בזמן שה-AI חושב.
//   2. AIFieldMark — סימון שדות שמולאו ע"י AI עם תווית "לאימות" + כפתור אישור.
//   3. wireExperimentAIController(controller) — חיווט אוטומטי ל-controller הקיים
//      דרך ה-hooks setBusy ו-applyExtraction (בלי לשנות את experiment.js).
//
// שימוש בסיסי (ראה ENHANCE-INTEGRATION.md):
//   import { wireExperimentAIController } from './experiment-ai-enhance.js';
//   wireExperimentAIController(myController);
// ─────────────────────────────────────────────────────────────────────────

/* ============================================================
   1) AIThinking — overlay חשיבה עם טקסט מתחלף
   ============================================================ */
const THINKING_MESSAGES = [
  'קורא את התמונות והטקסט...',
  'מזהה איזה נתון שייך לאיזה שדה...',
  'מחלץ ערכים ומנרמל תאריכים...',
  'בודק שהערכים חוקיים מול הטופס...',
  'מסנן תוכן לא רלוונטי...',
  'כמעט שם — מסדר את ההצעות...',
];

export const AIThinking = {
  _el: null,
  _msgEl: null,
  _timer: null,
  _idx: 0,

  _build() {
    if (this._el) return;
    const overlay = document.createElement('div');
    overlay.className = 'ai-thinking-overlay';
    overlay.setAttribute('role', 'status');
    overlay.setAttribute('aria-live', 'polite');
    overlay.innerHTML = `
      <div class="ai-thinking-card">
        <div class="ai-thinking-shimmer" aria-hidden="true"></div>
        <div class="ai-thinking-head">
          <span class="ai-thinking-orb"><i class="fas fa-wand-magic-sparkles"></i></span>
          <div class="ai-thinking-heading">
            <div class="ai-thinking-title">עוזר ה‑AI של מערכת איגום – ח״ץ</div>
            <div class="ai-thinking-thinking"><span>חושב</span><i class="ai-thinking-dots"><b></b><b></b><b></b></i></div>
          </div>
        </div>
        <div class="ai-thinking-message"></div>
        <div class="ai-thinking-track"><span class="ai-thinking-track-fill"></span></div>
        <div class="ai-thinking-model"></div>
      </div>`;
    document.body.appendChild(overlay);
    this._el = overlay;
    this._msgEl = overlay.querySelector('.ai-thinking-message');
    this._modelEl = overlay.querySelector('.ai-thinking-model');
    this._titleEl = overlay.querySelector('.ai-thinking-title');
  },

  /** מציג את המסך. אפשר להעביר {model, title, messages}. */
  show(options = {}) {
    this._build();
    this._idx = 0;
    if (options.title && this._titleEl) this._titleEl.textContent = options.title;
    if (this._modelEl) this._modelEl.textContent = options.model ? `מעבד באמצעות ${options.model}` : '';
    const messages = options.messages && options.messages.length ? options.messages : THINKING_MESSAGES;
    this._messages = messages;
    this._setMessage(messages[0]);
    requestAnimationFrame(() => this._el.classList.add('show'));

    clearInterval(this._timer);
    this._timer = setInterval(() => {
      this._idx = (this._idx + 1) % this._messages.length;
      this._swapMessage(this._messages[this._idx]);
    }, 2400);
  },

  /** מעדכן טקסט ידנית (למשל לפי שלב אמיתי). */
  setMessage(text) { this._swapMessage(text); },

  _setMessage(text) { if (this._msgEl) this._msgEl.textContent = text; },

  _swapMessage(text) {
    if (!this._msgEl) return;
    this._msgEl.classList.add('swap');
    setTimeout(() => {
      this._msgEl.textContent = text;
      this._msgEl.classList.remove('swap');
    }, 320);
  },

  hide() {
    clearInterval(this._timer);
    this._timer = null;
    if (this._el) this._el.classList.remove('show');
  },
};

/* ============================================================
   2) AIFieldMark — סימון שדות שמולאו ע"י AI
   ============================================================ */
export const AIFieldMark = {
  _marked: new Set(),

  /**
   * מסמן אלמנט קלט שמולא ע"י AI.
   * @param {HTMLElement} field  — input/select/textarea (או כל אלמנט).
   * @param {object} opts        — { sourceText, confidence }
   */
  mark(field, opts = {}) {
    if (!field) return;
    // שורת טבלה (כמו "פיזור קומפוסט") מסומנת אחרת: מסגרת על כל השורה + באנר
    // בתא הראשון, במקום עטיפת span שאינה חוקית בתוך <tr>.
    if (field.tagName === 'TR') { this._markRow(field, opts); return; }
    field.classList.add('ai-filled-field');
    if (opts.path) field.dataset.aiPath=opts.path;
    this._marked.add(field);

    // עטיפה כדי למקם תווית מעל השדה
    let wrap = field.closest('.ai-field-wrap');
    if (!wrap) {
      wrap = document.createElement('span');
      wrap.className = 'ai-field-wrap';
      field.parentNode.insertBefore(wrap, field);
      wrap.appendChild(field);
    }

    // הסרת תווית קודמת אם קיימת
    wrap.querySelector('.ai-verify-badge')?.remove();

    const badge = document.createElement('span');
    badge.className = 'ai-verify-badge';
    const conf = opts.confidence != null ? ` · ${Math.round(opts.confidence * 100)}%` : '';
    badge.innerHTML =
      `<i class="fas fa-robot"></i> מולא על ידי AI${conf}` +
      `<button type="button" class="ai-verify-ok" title="אשר ערך זה"><i class="fas fa-check"></i></button>`;
    if (opts.sourceText) badge.title = `מקור: ${opts.sourceText}`;

    badge.querySelector('.ai-verify-ok').addEventListener('click', (e) => {
      e.preventDefault();
      this.verify(field);
    });
    wrap.appendChild(badge);

    // עריכה ידנית של המשתמש = אימות אוטומטי
    const onEdit=()=>{this.verify(field);field.removeEventListener('input',onEdit);};
    if(field.matches?.('input, select, textarea'))field.addEventListener('input',onEdit);

    this._updateLegend();
  },

  /** מסמן שורת טבלה שמולאה ע"י AI: מסגרת על השורה + באנר בתא הראשון. */
  _markRow(tr, opts = {}) {
    tr.classList.add('ai-filled-row');
    if (opts.path) tr.dataset.aiPath = opts.path;
    this._marked.add(tr);

    const firstCell = tr.querySelector('td');
    if (firstCell) {
      firstCell.querySelector('.ai-row-badge')?.remove();
      const badge = document.createElement('span');
      badge.className = 'ai-row-badge';
      const conf = opts.confidence != null ? ` · ${Math.round(opts.confidence * 100)}%` : '';
      badge.innerHTML =
        `<i class="fas fa-robot"></i> מולא על ידי AI${conf}` +
        `<button type="button" class="ai-verify-ok" title="אשר שורה זו"><i class="fas fa-check"></i></button>`;
      if (opts.sourceText) badge.title = `מקור: ${opts.sourceText}`;
      badge.querySelector('.ai-verify-ok').addEventListener('click', (e) => {
        e.preventDefault();
        this.verify(tr);
      });
      firstCell.appendChild(badge);
    }

    // עריכה ידנית בתוך השורה = אימות אוטומטי של השורה.
    const onEdit = () => { this.verify(tr); tr.removeEventListener('input', onEdit, true); };
    tr.addEventListener('input', onEdit, true);

    this._updateLegend();
  },

  /** מסמן שדה/שורה כמאומתים (ירוק). */
  verify(field) {
    if (!field) return;
    if (field.tagName === 'TR') {
      field.classList.add('ai-verified');
      const badge = field.querySelector('.ai-row-badge');
      if (badge) {
        badge.classList.add('ai-verified');
        badge.innerHTML = '<i class="fas fa-check-circle"></i> אומת';
      }
      if (field.dataset.aiPath) AIReviewReport.verify(field.dataset.aiPath);
      this._updateLegend();
      return;
    }
    field.classList.add('ai-verified');
    const wrap = field.closest('.ai-field-wrap');
    const badge = wrap?.querySelector('.ai-verify-badge');
    if (badge) {
      badge.classList.add('ai-verified');
      badge.innerHTML = '<i class="fas fa-check-circle"></i> אומת';
    }
    if(field.dataset.aiPath)AIReviewReport.verify(field.dataset.aiPath);
    this._updateLegend();
  },

  /** מסיר את הסימון משדה/שורה ומחזיר את ה-DOM למצבו המקורי. */
  _unmark(field) {
    if (field.tagName === 'TR') {
      field.classList.remove('ai-filled-row', 'ai-verified');
      delete field.dataset.aiPath;
      field.querySelector('.ai-row-badge')?.remove();
      return;
    }
    field.classList.remove('ai-filled-field', 'ai-verified');
    delete field.dataset.aiPath;
    const wrap = field.closest('.ai-field-wrap');
    if (!wrap) return;
    wrap.querySelector('.ai-verify-badge')?.remove();
    // מפרקים גם את העטיפה, אחרת נשארת span מיותמת סביב כל שדה שסומן פעם.
    wrap.parentNode?.insertBefore(field, wrap);
    wrap.remove();
  },

  /** מנקה את כל הסימונים (למשל אחרי שמירה/ביטול). */
  clearAll() {
    this._marked.forEach((field) => this._unmark(field));
    this._marked.clear();
    this._updateLegend();
  },

  /**
   * מנקה סימונים של שדות שנמצאים בתוך root בלבד (למשל אחרי "שמור עמוד נוכחי").
   * שדות בעמודים אחרים נשארים מסומנים וממתינים לאימות.
   */
  clearWithin(root) {
    if (!root || typeof root.contains !== 'function') return;
    [...this._marked].forEach((field) => {
      if (!root.contains(field)) return;
      this._unmark(field);
      this._marked.delete(field);
    });
    this._updateLegend();
  },

  /** מספר השדות שעדיין לא אומתו. */
  pendingCount() {
    let n = 0;
    this._marked.forEach((f) => { if (!f.classList.contains('ai-verified')) n += 1; });
    return n;
  },

  _updateLegend() {
    // הבאנר הנפרד ("אשר הכל") אוחד אל תוך דוח מילוי ה-AI כדי לצמצם עומס.
    // אם נותר באנר ישן מגרסה קודמת – מסירים אותו, ומרעננים את כותרת הדוח.
    const legacy = document.getElementById('ai-verify-legend');
    if (legacy) legacy.remove();
    if (AIFieldMark.report && typeof AIFieldMark.report.render === 'function') {
      AIFieldMark.report.render();
    }
  },

  /** מאמת בבת אחת את כל השדות שסומנו על ידי AI (משמש את כפתור "אשר הכל" שבדוח). */
  verifyAllMarked() {
    [...this._marked].forEach((f) => this.verify(f));
  },
};

/* ============================================================
   3) AIReviewReport — דוח צדדי של שדות AI בכל העמודים
   ============================================================ */
export const AIReviewReport = {
  records: new Map(), hooks: {}, panel: null,
  configure(hooks={}) { this.hooks=hooks; this.ensure(); },
  register(update,meta={}) { const old=this.records.get(update.path)||{}; this.records.set(update.path,{...old,path:update.path,update,view:meta.view||old.view||'basic',viewLabel:meta.viewLabel||old.viewLabel||'תוכנית הניסוי',fieldLabel:meta.fieldLabel||old.fieldLabel||update.path,confidence:update.confidence,evidence:update.evidence||'',verified:old.verified||false}); this.render(); },
  clearAll(){this.records.clear();this.render();}, clearView(view){for(const[p,r]of this.records)if(r.view===view)this.records.delete(p);this.render();},
  verify(path){const r=this.records.get(path);if(r){r.verified=true;this.render();}},
  ensure(){if(this.panel?.isConnected)return this.panel;const p=document.createElement('aside');p.id='ai-review-report';p.className='ai-review-report hidden';p.setAttribute('aria-label','דוח שדות שמולאו על ידי AI');p.innerHTML=`<div class="ai-report-header"><div class="ai-report-heading"><strong><i class="fas fa-list-check"></i> דוח מילוי AI</strong><small></small></div><div class="ai-report-header-actions"><button type="button" class="ai-report-verify-all" title="אשר את כל השדות שמולאו על ידי AI"><i class="fas fa-check-double"></i> אשר הכל</button><button type="button" class="ai-report-toggle" aria-label="צמצום"><i class="fas fa-chevron-left"></i></button></div></div><div class="ai-report-pages"></div>`;p.querySelector('.ai-report-toggle').onclick=()=>p.classList.toggle('collapsed');p.querySelector('.ai-report-verify-all').onclick=()=>this.verifyAll();document.body.appendChild(p);this.panel=p;return p;},
  verifyAll(){AIFieldMark.verifyAllMarked?.();this.records.forEach(r=>r.verified=true);this.render();},
  async focus(path){const r=this.records.get(path);if(!r)return;await this.hooks.navigateTo?.(r);requestAnimationFrame(()=>requestAnimationFrame(()=>{const ts=toTargets(this.hooks.resolveField?.(r.path,r.update));ts.forEach(t=>AIFieldMark.mark(t,{confidence:r.confidence,sourceText:r.evidence,path:r.path}));const t=ts[0];if(t){t.scrollIntoView({behavior:'smooth',block:'center'});t.classList.add('ai-focus-pulse');setTimeout(()=>t.classList.remove('ai-focus-pulse'),1600);}}));},
  refreshView(view){requestAnimationFrame(()=>requestAnimationFrame(()=>{[...this.records.values()].filter(r=>r.view===view).forEach(r=>toTargets(this.hooks.resolveField?.(r.path,r.update)).forEach(t=>AIFieldMark.mark(t,{confidence:r.confidence,sourceText:r.evidence,path:r.path})));}));},
  render(){const p=this.ensure(),rows=[...this.records.values()];p.classList.toggle('hidden',!rows.length);const pending=rows.filter(r=>!r.verified).length;p.querySelector('.ai-report-header small').textContent=pending?`${pending} ממתינים לאימות`:'הכל אומת';const verifyBtn=p.querySelector('.ai-report-verify-all');if(verifyBtn)verifyBtn.style.display=pending?'':'none';const out=p.querySelector('.ai-report-pages');out.innerHTML='';const groups=new Map();rows.forEach(r=>{if(!groups.has(r.view))groups.set(r.view,[]);groups.get(r.view).push(r);});groups.forEach(items=>{const sec=document.createElement('section');sec.className='ai-report-page';sec.innerHTML=`<h4>${esc(items[0].viewLabel)} <span>${items.length}</span></h4>`;items.forEach(r=>{const b=document.createElement('button');b.type='button';b.className=`ai-report-item${r.verified?' verified':''}`;b.innerHTML=`<span><i class="fas ${r.verified?'fa-check-circle':'fa-robot'}"></i></span><span><strong>${esc(r.fieldLabel)}</strong><small>${r.confidence==null?'ממתין לבדיקה':`ביטחון ${Math.round(r.confidence*100)}%`}</small></span><i class="fas fa-arrow-left"></i>`;b.onclick=()=>this.focus(r.path);sec.appendChild(b);});out.appendChild(sec);});}
};
AIFieldMark.report = AIReviewReport;
function toTargets(v){return(Array.isArray(v)?v:[v]).filter(Boolean);}
function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));}

/* ============================================================
   4) חיווט אוטומטי ל-controller הקיים
   ============================================================ */

/**
 * עוטף את ה-controller כך ש:
 *   • בזמן busy (ניתוח) מוצג ה-overlay עם shimmer וטקסט מתחלף.
 *   • אחרי applyExtraction, השדות שמולאו מסומנים אוטומטית.
 *
 * לא משנה את experiment.js. מסתמך על setBusy ו-applyExtraction הקיימים.
 * @param {object} controller  — מופע ExperimentAIController.
 * @param {object} hooks       — אופציונלי: { resolveField(path) => HTMLElement }
 */
export function wireExperimentAIController(controller, hooks = {}) {
  if (!controller) return;
  AIReviewReport.configure(hooks);

  // --- (א) חיווט ה-overlay ל-setBusy ---
  const origSetBusy = controller.setBusy?.bind(controller);
  controller.setBusy = function (isBusy, message = '') {
    // מציג overlay רק בזמן ניתוח (לא בזמן שמירה), לפי הודעה
    const isAnalyzing = isBusy && /קורא|מנתח|ממפה|מקור/.test(message);
    if (isAnalyzing) {
      const model = controller.modelSelect?.value || 'gemini-3.6-flash';
      AIThinking.show({ model });
    } else if (!isBusy) {
      AIThinking.hide();
    }
    if (message) AIThinking.setMessage(message);
    return origSetBusy ? origSetBusy(isBusy, message) : undefined;
  };

  // --- (ב) חיווט הסימון ל-applyExtraction ---
  const userApply = controller.options?.applyExtraction;
  if (typeof userApply === 'function') {
    controller.options.applyExtraction = async function (payload, opts) {
      const applied = await userApply(payload, opts);
      try {
        markAppliedFields(payload, applied, hooks);
      } catch (e) {
        console.warn('AI field marking failed (non-fatal):', e);
      }
      return applied;
    };
  }

  // --- (ג) ניקוי סימונים בעת שמירה/ביטול ---
  const origSaveAll = controller.options?.saveAll;
  if (typeof origSaveAll === 'function') {
    controller.options.saveAll = async function (...args) {
      const ok = await origSaveAll(...args);
      if (ok) { AIFieldMark.clearAll(); AIReviewReport.clearAll(); }
      return ok;
    };
  }
  const origCancel = controller.options?.cancelDraft;
  if (typeof origCancel === 'function') {
    controller.options.cancelDraft = function (...args) {
      AIFieldMark.clearAll();
      AIReviewReport.clearAll();
      return origCancel(...args);
    };
  }
}

/**
 * מסמן את השדות שהוחלו. מנסה למצוא את אלמנט ה-DOM לכל update.
 * ניתן לספק hooks.resolveField(path) שמחזיר את האלמנט; אחרת נופל
 * לחיפוש לפי [data-field-path], id, או name.
 */
export function markAppliedFields(payload, applied, hooks = {}) {
  const updates=(payload&&payload.updates)||[]; const list=applied&&(applied.appliedPaths||applied.applied); if(!Array.isArray(list))return; const paths=new Set(list);
  updates.forEach(u=>{if(!paths.has(u.path))return;AIReviewReport.register(u,hooks.describeField?.(u.path,u)||{});toTargets(resolveField(u.path,hooks,u)).forEach(field=>AIFieldMark.mark(field,{confidence:u.confidence,sourceText:u.evidence||(u.source_refs&&u.source_refs.join(', ')),path:u.path}));});
}
function resolveField(path, hooks, update) {
  if (hooks.resolveField) {
    // ה-hook מכיר את מבנה העמוד (מקטע פעיל, טיפול פעיל). אם הוא החזיר null
    // זו תשובה סופית — ניחוש לפי שם קצר היה מסמן שדה של טיפול/מקטע אחר.
    return hooks.resolveField(path, update) || null;
  }
  // התאמה מדויקת לפי ה-path המלא בלבד
  const byPath =
    document.querySelector(`[data-field-path="${cssEscape(path)}"]`) ||
    document.querySelector(`[data-ai-path="${cssEscape(path)}"]`);
  if (byPath) return byPath;

  // נתיבי אוסף (טבלאות/רשימות) אינם שדה קלט בודד. חיפוש לפי המקטע
  // האחרון ב-path (למשל "date" או "value") היה עלול לפגוע בשדה שרירותי
  // בעל אותו id, ולכן לא מנחשים כאן.
  if (path.startsWith('collection.')) return null;

  // נסיונות ברירת מחדל לשדה סקלרי לפי שם קצר
  const short = path.split('.').pop();
  return (
    document.getElementById(short) ||
    document.querySelector(`[name="${cssEscape(short)}"]`) ||
    null
  );
}

function cssEscape(s) {
  if (window.CSS && CSS.escape) return CSS.escape(s);
  return String(s).replace(/["\\]/g, '\\$&');
}