// js/export.js
// Client-side experiment export — Excel (SheetJS) and ZIP (JSZip + FileSaver)
import { auth, db, storage, analytics } from "./firebase-config.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import {
    doc, getDoc, collection, collectionGroup, getDocs, query, orderBy, limit
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import {
    ref, listAll, getBlob
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-storage.js";
import { logEvent } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-analytics.js";
import { showToast } from "./toast.js";

let currentUser = null;
let userData = null;
let isAdmin = false;

// ── DOM Ready ──
document.addEventListener('DOMContentLoaded', () => {
    initSidebar();
});

function initSidebar() {
    const hamburgerBtn = document.getElementById('hamburger-btn');
    const sidebar = document.querySelector('.sidebar');
    const overlay = document.getElementById('sidebar-overlay');

    if (hamburgerBtn && sidebar) {
        hamburgerBtn.addEventListener('click', () => {
            sidebar.classList.toggle('open');
            if (overlay) overlay.classList.toggle('active');
            const icon = hamburgerBtn.querySelector('i');
            if (icon) { icon.classList.toggle('fa-bars'); icon.classList.toggle('fa-times'); }
        });
    }
    if (overlay) {
        overlay.addEventListener('click', () => {
            sidebar.classList.remove('open');
            overlay.classList.remove('active');
        });
    }

    const logoutBtn = document.getElementById('btn-logout');
    if (logoutBtn) logoutBtn.addEventListener('click', async () => { await signOut(auth); window.location.href = "index.html"; });
}

// ── Auth ──
onAuthStateChanged(auth, async (user) => {
    if (!user) { window.location.href = "index.html"; return; }
    currentUser = user;

    const userDocSnap = await getDoc(doc(db, "users", currentUser.uid));
    if (!userDocSnap.exists() || !userDocSnap.data().isApproved) { await signOut(auth); window.location.href = "index.html"; return; }
    userData = userDocSnap.data();

    const displayName = document.getElementById('user-display-name');
    if (displayName) displayName.textContent = `${userData.firstName || ''} ${userData.lastName || ''}`.trim() || currentUser.email;

    await checkAndDisplayAdminMenu();
    await loadExperimentsForExport();
});

// ── Admin menu (same logic as dashboard.js) ──
async function checkAndDisplayAdminMenu() {
    try {
        const usersQuery = query(collection(db, "users"), limit(2));
        const snapshot = await getDocs(usersQuery);
        if (snapshot.size > 1) {
            isAdmin = true;
            const sidebar = document.querySelector('.sidebar-nav');
            if (!sidebar) return;
            sidebar.insertAdjacentHTML('beforeend', `
                <div class="nav-separator"></div>
                <div class="nav-section-title">ניהול מערכת</div>
                <a href="admin-users.html" class="nav-item"><i class="fas fa-users-cog"></i><span>ניהול משתמשים</span></a>
                <a href="admin-experiments.html" class="nav-item"><i class="fas fa-flask"></i><span>כל הניסויים</span></a>
            `);
        }
    } catch (_) { /* no admin */ }
}

// ══════════════════════════════════════════
// Load experiments
// ══════════════════════════════════════════
async function loadExperimentsForExport() {
    const grid = document.getElementById('export-grid');
    const loading = document.getElementById('loading-container');
    if (!grid) return;

    const experiments = [];

    try {
        if (isAdmin) {
            // ── אדמין: טען את כל הניסויים במערכת דרך collectionGroup ──
            const allQuery = query(collectionGroup(db, 'experiments'));
            const allSnap = await getDocs(allQuery);

            allSnap.forEach(docSnap => {
                // חילוץ ownerUid מה-path: users/{ownerUid}/experiments/{id}
                const pathParts = docSnap.ref.path.split('/');
                const ownerUid = pathParts[1];
                const isOwn = ownerUid === currentUser.uid;

                experiments.push({
                    id: docSnap.id,
                    ownerUid: ownerUid,
                    data: docSnap.data(),
                    shared: !isOwn
                });
            });
        } else {
            // ── משתמש רגיל: הניסויים שלי + משותפים ──
            const myRef = collection(db, "users", currentUser.uid, "experiments");
            const mySnap = await getDocs(query(myRef, orderBy("createdAt", "desc")));
            mySnap.forEach(d => experiments.push({ id: d.id, ownerUid: currentUser.uid, data: d.data(), shared: false }));

            const sharedRef = collection(db, "users", currentUser.uid, "sharedExperiments");
            const sharedSnap = await getDocs(sharedRef);
            for (const sd of sharedSnap.docs) {
                const s = sd.data();
                if (s.ownerUid && s.experimentId) {
                    try {
                        const origSnap = await getDoc(doc(db, "users", s.ownerUid, "experiments", s.experimentId));
                        if (origSnap.exists()) experiments.push({ id: s.experimentId, ownerUid: s.ownerUid, data: origSnap.data(), shared: true });
                    } catch (_) {}
                }
            }
        }
    } catch (err) {
        console.error("Error loading experiments:", err);
        showToast('שגיאה בטעינת הניסויים', 'error');
    }

    if (loading) loading.classList.add('hidden');
    grid.style.display = 'flex';

    if (experiments.length === 0) {
        grid.innerHTML = '<div class="export-empty"><i class="fas fa-flask"></i><p>אין ניסויים להצגה</p></div>';
        return;
    }

    // מיון לפי תאריך יצירה (חדשים קודם)
    experiments.sort((a, b) => {
        const dateA = a.data.createdAt?.toDate?.() || new Date(0);
        const dateB = b.data.createdAt?.toDate?.() || new Date(0);
        return dateB - dateA;
    });

    experiments.forEach(exp => grid.appendChild(createExportCard(exp)));
}

// ══════════════════════════════════════════
// Create export card
// ══════════════════════════════════════════
function createExportCard(exp) {
    const card = document.createElement('div');
    card.className = 'export-card';

    const name = exp.data.experimentName || 'ניסוי ללא שם';
    const site = exp.data.experimentSite || '';
    const dateStr = formatDate(exp.data.createdAt);
    const badge = exp.shared
        ? (isAdmin && exp.ownerUid !== currentUser.uid
            ? '<span class="export-badge shared"><i class="fas fa-user"></i> של משתמש אחר</span>'
            : '<span class="export-badge shared"><i class="fas fa-users"></i> שותף</span>')
        : '<span class="export-badge owner"><i class="fas fa-user-check"></i> שלי</span>';

    card.innerHTML = `
        <div class="export-card-header">
            <div class="export-card-title"><i class="fas fa-flask"></i><span>${name}</span>${badge}</div>
            <div class="export-card-meta">
                ${dateStr ? `<span><i class="fas fa-calendar-alt"></i>${dateStr}</span>` : ''}
                ${site ? `<span><i class="fas fa-map-marker-alt"></i>${site}</span>` : ''}
                ${exp.data.leadResearcher ? `<span><i class="fas fa-user"></i>${exp.data.leadResearcher}</span>` : ''}
            </div>
        </div>
        <div class="export-card-actions">
            <button class="btn-export excel" data-type="excel" title="הורדת Excel עם כל נתוני הניסוי">
                <i class="fas fa-file-excel"></i>
                <span>הורד Excel</span>
            </button>
            <button class="btn-export zip" data-type="zip" title="הורדת ZIP — Excel + כל הקבצים המצורפים">
                <i class="fas fa-file-archive"></i>
                <span>הורד ZIP (Excel + קבצים)</span>
            </button>
        </div>
        <div class="export-progress" id="progress-${exp.id}">
            <i class="fas fa-spinner fa-spin"></i>
            <span class="progress-text">מכין קבצים...</span>
        </div>
    `;

    card.querySelector('[data-type="excel"]').addEventListener('click', (e) => handleExport(e, exp, 'excel'));
    card.querySelector('[data-type="zip"]').addEventListener('click', (e) => handleExport(e, exp, 'zip'));

    return card;
}

// ══════════════════════════════════════════
// Handle Export
// ══════════════════════════════════════════
async function handleExport(e, exp, type) {
    const btn = e.currentTarget;
    const card = btn.closest('.export-card');
    const progressEl = card.querySelector('.export-progress');
    const progressText = progressEl?.querySelector('.progress-text');
    const allBtns = card.querySelectorAll('.btn-export');

    allBtns.forEach(b => b.disabled = true);
    if (progressEl) progressEl.classList.add('active');

    try {
        const setProgress = (msg) => { if (progressText) progressText.textContent = msg; };

        setProgress('שולף נתוני ניסוי...');
        const data = exp.data;

        setProgress('בונה קובץ Excel...');
        const wb = buildExcelWorkbook(data);

        if (type === 'excel') {
            const fileName = sanitizeFileName(data.experimentName || 'experiment') + '.xlsx';
            XLSX.writeFile(wb, fileName);
            showToast('קובץ Excel הורד בהצלחה!', 'success');

            // --> דיווח על הורדת אקסל <--
            try {
                logEvent(analytics, 'export_experiment', { format: 'excel', experiment_id: exp.id });
            } catch (analyticsErr) {
                console.warn('Analytics logEvent failed:', analyticsErr);
            }

        } else {
            setProgress('מכין קובץ ZIP...');
            const zip = new JSZip();

            const xlsxData = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
            const excelName = sanitizeFileName(data.experimentName || 'experiment') + '.xlsx';
            zip.file(excelName, xlsxData);

            setProgress('מוריד קבצים מ-Storage...');
            await addStorageFilesToZip(zip, exp, setProgress);


            setProgress('יוצר קובץ ZIP...');
            const zipBlob = await zip.generateAsync({ type: 'blob' }, (metadata) => {
                setProgress(`יוצר ZIP... ${Math.round(metadata.percent)}%`);
            });

            const zipName = sanitizeFileName(data.experimentName || 'experiment') + '.zip';
            saveAs(zipBlob, zipName);
            showToast('קובץ ZIP הורד בהצלחה!', 'success');

            // --> דיווח על הורדת ZIP <--
            try {
                logEvent(analytics, 'export_experiment', { format: 'zip', experiment_id: exp.id });
            } catch (analyticsErr) {
                console.warn('Analytics logEvent failed:', analyticsErr);
            }
        }
    } catch (err) {
        console.error("Export error:", err);
        showToast('שגיאה בייצוא: ' + err.message, 'error');
    } finally {
        allBtns.forEach(b => b.disabled = false);
        if (progressEl) progressEl.classList.remove('active');
    }
}

// ══════════════════════════════════════════════════════════════════
// Build Excel — ONE sheet, organized with section headers
// ══════════════════════════════════════════════════════════════════
function buildExcelWorkbook(data) {
    const wb = XLSX.utils.book_new();
    const rows = [];

    function addSection(title) {
        rows.push([]);
        rows.push(['═══  ' + title + '  ═══']);
        rows.push([]);
    }
    function addField(label, value) {
        rows.push([label, value !== undefined && value !== null ? String(value) : '']);
    }
    function addTable(headers, dataRows) {
        rows.push(headers);
        dataRows.forEach(r => rows.push(r));
        rows.push([]);
    }

    // ── 1. תוכנית הניסוי ──
    addSection('תוכנית הניסוי');
    addField('שם הניסוי', data.experimentName);
    addField('חוקר מוביל', data.leadResearcher);
    addField('שותפים', (data.partners || []).map(p => `${p.name} (${p.email})`).join(', '));
    addField('שנת ניסוי', data.experimentYear);
    addField('חודש ניסוי', data.experimentMonth);
    addField('תאריך תחילה', data.startDate);
    addField('חבילת עבודה', data.workPackage);
    addField('אתר הניסוי', data.experimentSite);
    addField('קורדינטות', data.siteCoordinates);
    addField('מטרת הניסוי', data.experimentGoal);
    addField('תקציר', data.experimentSummary);
    addField('מספר טיפולים', data.treatmentsCount);
    addField('מספר חזרות', data.repetitionsCount);
    addField('משתנים בלתי תלויים', (data.independentVariables || []).join(', '));
    addField('מספר רמות', data.levelsCount);
    addField('ערך', data.levelValue);
    addField('משתנים תלויים', (data.dependentVariables || []).join(', '));
    addField('מילות מפתח', (data.keywords || []).join(', '));

    if (data.treatments && data.treatments.length > 0) {
        rows.push([]);
        rows.push(['פרטי טיפולים:']);
        addTable(
            ['מספר', 'שם הטיפול', 'חומר הדברה'],
            data.treatments.map((t, i) => [i + 1, t.name || '', t.pesticide || ''])
        );
    }

    // ── 2. הכנות לניסוי > פרטי הגידול ──
    const crop = data.cropDetails?.data || {};
    addSection('הכנות לניסוי > פרטי הגידול');
    addField('נתונים משותפים לכל הטיפולים', data.cropDetails?.shared ? 'כן' : 'לא');
    addField('מועד שתילה', crop.plantingDate);
    addField('סוג גידול', crop.cropType);
    addField('זן', crop.variety);
    addField('צמח מורכב', crop.graftedPlant);
    addField('סוג הזן', crop.varietyType);
    addField('צמח מפוצל', crop.splitPlant);
    addField('משתלה', crop.nursery);
    addField('כמות שתילים', crop.seedlingsCount);
    addField('עומד שתילה', crop.plantingDensity);
    addField('מבנה שתילה', crop.plantingStructure);
    addField('שטח הניסוי (דונם)', crop.experimentArea);
    addField('שם הכנה', crop.preparationName);
    addField('הערות', crop.notes);

    // ── 3. הכנות לניסוי > מבנה ──
    const structure = data.structureDetails?.data || {};
    addSection('הכנות לניסוי > מבנה');
    addField('נתונים משותפים לכל הטיפולים', data.structureDetails?.shared ? 'כן' : 'לא');
    addField('סוג המבנה', structure.type);
    addField('גודל מבנה (דונם)', structure.size);
    addField('מספר גמלונים', structure.tunnels);
    addField('אורך שלוחה (מ\')', structure.length);
    addField('רוחב גמלון (מ\')', structure.width);
    addField('חיפוי גג', structure.roofCovering);
    addField('שטיפת רשתות', structure.netWashing);
    addField('מפנה המבנה', structure.direction);
    addField('פעולות חריגות', structure.notes);

    // ── 4. הכנות לניסוי > טיפול בקרקע ──
    const soil = data.soilDetails?.data || {};
    addSection('הכנות לניסוי > טיפול בקרקע');
    addField('נתונים משותפים לכל הטיפולים', data.soilDetails?.shared ? 'כן' : 'לא');
    addField('מצע מנותק', soil.detachedSubstrate);
    addField('סוג החברה', soil.substrateCompany);
    addField('סוג המצע', soil.substrateType);
    addField('נפח המצע', soil.substrateVolume);
    addField('חיפוי קרקע/כסף', soil.mulch);
    addField('חיטוי סולרי', soil.solarization);
    addField('חיטוי בהמטרה אדיגן', soil.disinfectionAdigan);
    addField('כמות אדיגן', soil.adiganAmount);

    if (soil.compostRows?.length > 0) {
        rows.push([]); rows.push(['פיזור קומפוסט:']);
        addTable(['תאריך', 'כמות', 'אופן יישום'], soil.compostRows.map(r => [r.date || '', r.amount || '', r.method || '']));
    }
    if (soil.sprayRows?.length > 0) {
        rows.push(['ריסוס מונע הצצה:']);
        addTable(['תאריך', 'כמות', 'אופן יישום'], soil.sprayRows.map(r => [r.date || '', r.amount || '', r.method || '']));
    }
    if (soil.disinfectRows?.length > 0) {
        rows.push(['חיטוי קרקע:']);
        addTable(['תאריך', 'חומר החיטוי', 'כמות', 'אופן יישום'], soil.disinfectRows.map(r => [r.date || '', r.material || '', r.amount || '', r.method || '']));
    }

    // ── 5. הכנות לניסוי > סוג ופריסת הטפטוף ──
    const drip = data.dripDetails?.data || {};
    addSection('הכנות לניסוי > סוג ופריסת הטפטוף');
    addField('נתונים משותפים לכל הטיפולים', data.dripDetails?.shared ? 'כן' : 'לא');
    addField('שלוחה בודדת/כפולה', drip.singleDouble);
    addField('קוטר צינור טפטוף', drip.pipeDiameter);
    addField('מרחק בין טפטפות (ס"מ)', drip.emitterSpacing);
    addField('ספיקה (ליטר/שעה)', drip.flowRate);
    addField('מס\' שלוחות (יח\')', drip.linesCount);
    addField('מרחק בין שלוחות טפטוף (ס"מ)', drip.linesSpacing);
    addField('מרחק בין מרכז ערוגות (מטר)', drip.bedSpacing);

    // ── 6. מהלך הניסוי > השקיה ודשן ──
    addSection('מהלך הניסוי > השקיה ודשן');
    const irrigationData = data.irrigationData || [];
    if (irrigationData.length > 0) {
        rows.push(['השקיה:']);
        addTable(
            ['שם הקובץ', 'תאריך העלאה', 'תאריכי מדידה', 'סה"כ כמות מים (ליטר)', 'קישור קובץ'],
            irrigationData.map(r => [r.fileName || '', r.uploadDate || '', r.measureDates || '', r.totalWater || '', r.fileUrl || ''])
        );
    } else { addField('השקיה', 'אין נתונים'); }

    const fertilizationData = data.fertilizationData || [];
    if (fertilizationData.length > 0) {
        rows.push(['דישון:']);
        addTable(
            ['שם הקובץ', 'תאריך העלאה', 'תאריכי מדידה', 'סוג הדשן', 'חברה', 'סה"כ כמות דשן', 'קישור קובץ'],
            fertilizationData.map(r => [r.fileName || '', r.uploadDate || '', r.measureDates || '', r.fertType || '', r.company || '', r.totalFert || '', r.fileUrl || ''])
        );
    } else { addField('דישון', 'אין נתונים'); }

    // ── 7. מהלך הניסוי > צימוח ──
    const growthData = data.growthData || [];
    addSection('מהלך הניסוי > צימוח');
    if (growthData.length > 0) {
        addTable(['נתון', 'ערך', 'תאריך מדידה'], growthData.map(r => [r.name || '', r.value || '', r.measureDate || '']));
    } else { addField('צימוח', 'אין נתונים'); }

    // ── 8. מהלך הניסוי > נתוני אקלים וסנסורים ──
    const climateData = data.climateData || [];
    addSection('מהלך הניסוי > נתוני אקלים וסנסורים');
    if (climateData.length > 0) {
        addTable(
            ['נתון', 'מיקום מדידה', 'מיקום חיישן במרחב', 'גובה/עומק חיישן', 'תאריכי מדידה', 'הערות'],
            climateData.map(r => [r.name || '', r.location || '', r.sensorPosition || '', r.sensorDepth || '', r.measureDates || '', r.notes || ''])
        );
    } else { addField('אקלים', 'אין נתונים'); }

    // ── 9. מהלך הניסוי > אגרוטכניקה ──
    const agroData = data.agrotechnicsData || [];
    addSection('מהלך הניסוי > אגרוטכניקה');
    if (agroData.length > 0) {
        addTable(
            ['פעולה', 'תאריך ביצוע הפעולה', 'כמות שעות לפעולה', 'כמות עובדים לפעולה'],
            agroData.map(r => [r.action || '', r.actionDate || '', r.hours || '', r.workers || ''])
        );
    } else { addField('אגרוטכניקה', 'אין נתונים'); }

    // ── 10. מהלך הניסוי > הגנת הצומח ──
    const pp = data.plantProtectionData || {};
    addSection('מהלך הניסוי > הגנת הצומח');
    const pests = pp.pests || [];
    if (pests.length > 0) { rows.push(['מזיקים:']); addTable(['מפגע שאובחן', 'תאריך', 'הערות'], pests.map(r => [r.pest || '', r.date || '', r.notes || ''])); }
    const diseases = pp.diseases || [];
    if (diseases.length > 0) { rows.push(['מחלות:']); addTable(['מפגע שאובחן', 'תאריך', 'הערות'], diseases.map(r => [r.pest || '', r.date || '', r.notes || ''])); }
    const sprays = pp.sprays || [];
    if (sprays.length > 0) { rows.push(['ריסוסים:']); addTable(['חומר', 'תאריך', 'מינון לטיפול', 'משולב עם חומרים נוספים', 'הערות'], sprays.map(r => [r.material || '', r.date || '', r.dosage || '', r.combined || '', r.notes || ''])); }
    const drenches = pp.drenches || [];
    if (drenches.length > 0) { rows.push(['הגמעות:']); addTable(['חומר', 'תאריך', 'מינון לטיפול', 'משולב עם חומרים נוספים', 'הערות'], drenches.map(r => [r.material || '', r.date || '', r.dosage || '', r.combined || '', r.notes || ''])); }
    if (pests.length === 0 && diseases.length === 0 && sprays.length === 0 && drenches.length === 0) { addField('הגנת הצומח', 'אין נתונים'); }

    // ── 11. נתוני יבול ──
    const yd = data.yieldData || {};
    addSection('נתוני יבול');
    const measures = yd.measures || [];
    if (measures.length > 0) { rows.push(['מדידות יבול:']); addTable(['תאריך מדידה', 'קומת הפרי', 'איכות (לק"ג)', 'כמות (ק"ג)', 'תיאור הפרי', 'הערות'], measures.map(r => [r.measureDate || '', r.fruitFloor || '', r.quality || '', r.quantity || '', r.fruitDesc || '', r.notes || ''])); }
    const damages = yd.damages || [];
    if (damages.length > 0) { rows.push(['נזקי יבול:']); addTable(['תאריך מדידה', 'הפגע הנמדד', 'מדד נזק (%/ס"מ/No.)', 'ערך הנזק', 'תיאור הנזק'], damages.map(r => [r.measureDate || '', r.damage || '', r.damageIndex || '', r.damageValue || '', r.damageDesc || ''])); }
    if (measures.length === 0 && damages.length === 0) { addField('נתוני יבול', 'אין נתונים'); }

    // ── 12. יומן אירועים ──
    const events = data.events || [];
    addSection('יומן אירועים');
    if (events.length > 0) {
        addTable(['תאריך', 'תיאור', 'שם קובץ', 'קישור קובץ'], events.map(e => [e.date || '', e.description || '', e.fileName || '', e.fileUrl || '']));
    } else { addField('אירועים', 'אין נתונים'); }

    // ── Build sheet ──
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [{ wch: 35 }, { wch: 30 }, { wch: 25 }, { wch: 25 }, { wch: 25 }, { wch: 25 }, { wch: 45 }];

    // Set sheet to RTL for Hebrew
    if (!ws['!sheetViews']) ws['!sheetViews'] = [{}];
    ws['!sheetViews'][0].rightToLeft = true;

    XLSX.utils.book_append_sheet(wb, ws, 'ניסוי מלא');

    // Set workbook views to RTL
    if (!wb.Workbook) wb.Workbook = {};
    if (!wb.Workbook.Views) wb.Workbook.Views = [{}];
    wb.Workbook.Views[0].RTL = true;

    return wb;
}

// ══════════════════════════════════════════════════════════════
// Fetch ALL files from Firebase Storage into ZIP (recursive)
// Uses Firebase SDK getBlob() — authenticated, no CORS issues
// Maps English Storage folder names to Hebrew for the ZIP
// ══════════════════════════════════════════════════════════════

// Map Storage folder names (English) to Hebrew display names
const FOLDER_NAME_MAP = {
    'events': 'אירועים',
    'irrigation': 'השקיה',
    'fertilization': 'דישון',
    'growth': 'צימוח',
    'climate': 'אקלים',
    'agrotechnics': 'אגרוטכניקה',
    'protection': 'הגנת_הצומח',
    'yield': 'יבול'
};

async function addStorageFilesToZip(zip, exp, setProgress) {
    const filesFolder = zip.folder('קבצים_מצורפים');
    let fileCount = 0;
    let errorCount = 0;

    async function scanFolder(storageRef, zipFolder) {
        let result;
        try {
            result = await listAll(storageRef);
        } catch (err) {
            console.warn(`Cannot list: ${storageRef.fullPath}`, err.message);
            return;
        }

        for (const itemRef of result.items) {
            try {
                fileCount++;
                setProgress(`מוריד קובץ ${fileCount}: ${itemRef.name}`);
                const blob = await getBlob(itemRef);
                zipFolder.file(itemRef.name, blob);
            } catch (fileErr) {
                errorCount++;
                console.error(`Failed to download ${itemRef.fullPath}:`, fileErr.message);
            }
        }

        for (const prefixRef of result.prefixes) {
            // Use Hebrew folder name if mapped, otherwise keep original
            const hebrewName = FOLDER_NAME_MAP[prefixRef.name] || prefixRef.name;
            const subFolder = zipFolder.folder(hebrewName);
            await scanFolder(prefixRef, subFolder);
        }
    }

    const storagePath = `users/${exp.ownerUid}/experiments/${exp.id}`;
    const storageRef = ref(storage, storagePath);
    await scanFolder(storageRef, filesFolder);

    if (fileCount === 0) {
        setProgress('אין קבצים מצורפים ב-Storage');
    } else if (errorCount > 0) {
        setProgress(`${fileCount - errorCount}/${fileCount} קבצים הורדו (${errorCount} שגיאות)`);
        showToast(`${errorCount} קבצים לא הורדו — בדוק הרשאות Storage`, 'warning');
    } else {
        setProgress(`סה"כ ${fileCount} קבצים מ-Storage נוספו ל-ZIP`);
    }
}


// ── Helpers ──
function sanitizeFileName(name) {
    return name.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_').substring(0, 100);
}

function formatDate(timestamp) {
    if (!timestamp) return '';
    try {
        const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
        return date.toLocaleDateString('he-IL');
    } catch { return ''; }
}
