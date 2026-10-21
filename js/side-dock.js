// =========================================
// Side Dock - Shared JS
// One collapsible tool rail on the left edge that holds the helper widgets
// (accessibility, AI assistant, research map, chatbot), so they read as a
// separate side panel instead of loose buttons floating over the page.
// =========================================
//
// Must load as a classic script BEFORE accessibility.js / chatbot.js, so
// window.SideDock exists when they run. Each widget calls SideDock.add(); on a
// page that does not load this file the widgets keep their legacy floating
// position, so leaving it out is safe.

(function () {
    'use strict';

    const STORAGE_KEY = 'side-dock-collapsed';
    // Same breakpoint the widgets use for their own mobile layout.
    const MOBILE_QUERY = '(max-width: 768px)';

    const items = new Map();
    let dock = null;

    function readSavedCollapsed() {
        try {
            const saved = localStorage.getItem(STORAGE_KEY);
            if (saved === '1') return true;
            if (saved === '0') return false;
        } catch (_) {
            // Persistence is optional.
        }
        // No saved choice yet: on a phone the open rail covers too much content.
        return window.matchMedia(MOBILE_QUERY).matches;
    }

    function closeAll(exceptKey) {
        items.forEach((item, key) => {
            if (key !== exceptKey) item.close?.();
        });
    }

    function setCollapsed(collapsed, persist) {
        dock.root.classList.toggle('collapsed', collapsed);
        document.documentElement.classList.toggle('side-dock-collapsed', collapsed);

        const label = collapsed ? 'הצגת סרגל הכלים' : 'הסתרת סרגל הכלים';
        dock.handle.setAttribute('aria-expanded', String(!collapsed));
        dock.handle.setAttribute('aria-label', label);
        dock.handle.title = label;

        // A panel left open would otherwise reappear by itself on the next expand.
        if (collapsed) closeAll();

        if (persist) {
            try {
                localStorage.setItem(STORAGE_KEY, collapsed ? '1' : '0');
            } catch (_) {
                // Persistence is optional.
            }
        }
    }

    function ensureDock() {
        if (dock) return dock;

        const root = document.createElement('aside');
        root.className = 'side-dock side-dock-preload';
        root.id = 'side-dock';
        root.setAttribute('aria-label', 'סרגל כלי עזר');
        root.innerHTML = `
            <div class="side-dock-card" id="side-dock-card">
                <div class="side-dock-title" aria-hidden="true">כלי עזר</div>
                <div class="side-dock-items"></div>
            </div>
            <button type="button" class="side-dock-handle" id="side-dock-handle" aria-controls="side-dock-card">
                <i class="fa-solid fa-chevron-left" aria-hidden="true"></i>
            </button>
        `;
        document.body.appendChild(root);

        dock = {
            root,
            list: root.querySelector('.side-dock-items'),
            handle: root.querySelector('.side-dock-handle')
        };

        document.documentElement.classList.add('has-side-dock');
        setCollapsed(readSavedCollapsed(), false);

        dock.handle.addEventListener('click', () => {
            setCollapsed(!root.classList.contains('collapsed'), true);
        });

        // Apply the saved state without animating it on page load: flush styles
        // while transitions are off, so turning them back on starts nothing.
        void root.offsetWidth;
        root.classList.remove('side-dock-preload');

        return dock;
    }

    /**
     * Move a widget into the dock.
     *   key    - unique id, also exposed as data-side-dock-tile on the button
     *   order  - position in the rail (lower = higher up)
     *   label  - short visible text under the icon; becomes the accessible name
     *   icon   - Font Awesome classes for the tile icon
     *   root   - the widget's outer element (launcher + its panel), moved as-is
     *   button - the launcher inside root (may be root itself)
     *   close  - optional; closes the widget's panel. Called when another tile
     *            is clicked and when the dock collapses, so one panel shows at a time.
     * Returns true once docked.
     */
    function add({ key, order = 0, label, icon, root, button, close }) {
        if (!key || !root || !button) return false;
        const { list } = ensureDock();

        // The dock owns the launcher's look. Dropping the legacy classes drops
        // their floating styles too (fixed sizes, !important colours, the chat
        // pulse) instead of fighting them one override at a time. The widgets
        // reach their launchers by id, never by these classes.
        button.className = 'side-dock-tile';
        button.dataset.sideDockTile = key;
        button.removeAttribute('aria-label');
        if (!button.title) button.title = label;

        const iconEl = document.createElement('i');
        iconEl.className = `${icon} side-dock-tile-icon`;
        iconEl.setAttribute('aria-hidden', 'true');
        const labelEl = document.createElement('span');
        labelEl.className = 'side-dock-tile-label';
        labelEl.textContent = label;
        button.replaceChildren(iconEl, labelEl);

        root.classList.add('side-dock-item');
        root.style.order = String(order);
        list.appendChild(root);

        items.set(key, { close });
        button.addEventListener('click', () => closeAll(key));
        return true;
    }

    window.SideDock = { add };
})();
