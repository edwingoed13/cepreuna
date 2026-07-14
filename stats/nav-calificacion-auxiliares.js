(function () {
  let session;
  try { session = JSON.parse(localStorage.getItem('stats_session') || 'null'); } catch (_) { return; }
  const role = session?.user?.role;
  const isCoordinator = role === 'Coordinador Auxiliar';
  const isAdmin = ['Administrador', 'Super Admin', 'Oficina de Administración'].includes(role);
  if (!isCoordinator && !isAdmin) return;

  const href = isCoordinator ? '/stats/calificacion-auxiliares' : '/stats/resultados-calificacion-auxiliares';
  if (location.pathname === href) return;
  const label = isCoordinator ? 'Calificación auxiliares' : 'Resultados auxiliares';
  const mobileLabel = isCoordinator ? 'Auxiliares' : 'Resultados';

  const sidebar = document.querySelector('aside nav');
  if (sidebar && !sidebar.querySelector(`[href="${href}"]`)) {
    const link = document.createElement('a');
    link.href = href;
    link.className = 'flex items-center gap-3 px-3 py-2.5 rounded-lg text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors';
    link.innerHTML = `<span class="material-symbols-outlined">fact_check</span><span class="font-medium">${label}</span>`;
    sidebar.appendChild(link);
  }

  const mobile = [...document.querySelectorAll('nav')].find(n => n.classList.contains('fixed') && n.classList.contains('bottom-0'));
  if (mobile && !mobile.querySelector(`[href="${href}"]`)) {
    const link = document.createElement('a');
    link.href = href;
    link.className = 'flex flex-col items-center gap-1 text-slate-400';
    link.innerHTML = `<span class="material-symbols-outlined">fact_check</span><span class="text-[9px] font-bold uppercase">${mobileLabel}</span>`;
    mobile.appendChild(link);
  }
})();
