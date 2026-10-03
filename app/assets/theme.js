// Apply a saved theme before first paint (avoids a flash of the wrong theme).
try { const t = localStorage.getItem('rb-theme'); if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t; } catch (_) { /* storage unavailable */ }
