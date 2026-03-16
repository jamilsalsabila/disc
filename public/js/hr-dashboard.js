(function () {
  const isMobile = window.matchMedia('(max-width: 860px)').matches;
  const filterForm = document.getElementById('hr-filter-form');
  const tableBody = document.getElementById('candidate-table-body');

  let roleChart;
  let discChart;

  const roleLabels = {
    SERVER_SPECIALIST: 'Server Specialist',
    BEVERAGE_SPECIALIST: 'Beverage Specialist',
    SENIOR_COOK: 'Senior Cook',
    INCOMPLETE: 'Incomplete',
    TIDAK_DIREKOMENDASIKAN: 'Tidak Direkomendasikan'
  };

  function mapRec(value) {
    return roleLabels[value] || '-';
  }

  function escapeHtml(value) {
    const str = String(value ?? '');
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function renderRoleChart(roleData) {
    const roleCtx = document.getElementById('roleChart');
    if (!roleCtx) return;

    if (roleChart) {
      roleChart.destroy();
    }

    const labels = roleData.map((r) => mapRec(r.recommendation));
    const values = roleData.map((r) => r.total);

    roleChart = new Chart(roleCtx, {
      type: 'doughnut',
      data: {
        labels: labels.length ? labels : ['Belum ada data'],
        datasets: [{
          data: values.length ? values : [1],
          backgroundColor: values.length
            ? ['#F97316', '#0EA5E9', '#14B8A6', '#94A3B8', '#A3A3A3']
            : ['#CBD5E1'],
          borderWidth: 0,
          hoverOffset: 10
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '62%',
        radius: isMobile ? '84%' : '74%',
        plugins: {
          legend: {
            position: isMobile ? 'bottom' : 'right',
            labels: {
              boxWidth: 12,
              boxHeight: 12,
              usePointStyle: true,
              pointStyle: 'circle',
              padding: isMobile ? 12 : 16
            }
          }
        }
      }
    });
  }

  function renderDiscChart(avgDisc) {
    const discCtx = document.getElementById('discChart');
    if (!discCtx) return;

    if (discChart) {
      discChart.destroy();
    }

    discChart = new Chart(discCtx, {
      type: 'bar',
      data: {
        labels: ['D', 'I', 'S', 'C'],
        datasets: [{
          label: 'Rata-rata',
          data: [avgDisc.avg_d || 0, avgDisc.avg_i || 0, avgDisc.avg_s || 0, avgDisc.avg_c || 0],
          backgroundColor: ['#FB7185', '#FACC15', '#2DD4BF', '#60A5FA'],
          borderRadius: 10,
          maxBarThickness: isMobile ? 36 : 48
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false }
        },
        scales: {
          y: {
            beginAtZero: true,
            suggestedMax: 48,
            ticks: { stepSize: 8 },
            grid: { color: '#E2E8F0' }
          },
          x: {
            grid: { display: false }
          }
        }
      }
    });
  }

  function attachRowHandlers() {
    const rows = document.querySelectorAll('.candidate-row[data-href]');
    rows.forEach((row) => {
      row.addEventListener('click', (event) => {
        const interactive = event.target.closest('a, button, input, select, textarea');
        if (interactive) {
          return;
        }
        const href = row.getAttribute('data-href');
        if (href) {
          window.location.href = href;
        }
      });
    });
  }

  function renderCandidateTable(candidates) {
    if (!tableBody) {
      return;
    }

    if (!candidates.length) {
      tableBody.innerHTML = '<tr><td colspan="7">Belum ada data kandidat.</td></tr>';
      return;
    }

    tableBody.innerHTML = candidates.map((candidate) => {
      return `
        <tr class="candidate-row" data-href="/hr/candidates/${candidate.id}">
          <td>#${candidate.id}</td>
          <td>
            <strong>${escapeHtml(candidate.full_name)}</strong><br>
            <small>${escapeHtml(candidate.email)}</small>
          </td>
          <td>${escapeHtml(candidate.selected_role)}</td>
          <td>${escapeHtml(mapRec(candidate.recommendation))}</td>
          <td>D ${candidate.disc_d ?? 0} / I ${candidate.disc_i ?? 0} / S ${candidate.disc_s ?? 0} / C ${candidate.disc_c ?? 0}</td>
          <td>${escapeHtml(candidate.status)}</td>
          <td>
            <a href="/hr/candidates/${candidate.id}" class="table-link btn-detail">Detail Profil</a>
            <button type="button" class="btn-danger-outline delete-candidate-btn" data-id="${candidate.id}" data-name="${escapeHtml(candidate.full_name)}">Hapus</button>
          </td>
        </tr>
      `;
    }).join('');

    attachRowHandlers();
  }

  function renderDashboard(payload) {
    renderCandidateTable(payload.candidates || []);
    renderRoleChart((payload.stats && payload.stats.roleDistribution) || []);
    renderDiscChart((payload.stats && payload.stats.avgDisc) || {});
  }

  async function fetchAndRender() {
    if (!filterForm) return;
    const params = new URLSearchParams(new FormData(filterForm));
    const qs = params.toString();

    const response = await fetch(`/hr/api/candidates?${qs}`, {
      headers: { Accept: 'application/json' }
    });
    if (response.status === 401) {
      window.location.href = '/hr/login';
      return;
    }
    if (!response.ok) {
      return;
    }

    const payload = await response.json();
    renderDashboard(payload);

    const nextUrl = qs ? `/hr/dashboard?${qs}` : '/hr/dashboard';
    window.history.replaceState({}, '', nextUrl);
    return payload;
  }

  function setupLiveFilters() {
    if (!filterForm) return;
    const searchInput = filterForm.querySelector('input[name="search"]');
    const roleSelect = filterForm.querySelector('select[name="role"]');
    const recommendationSelect = filterForm.querySelector('select[name="recommendation"]');
    const resetButton = document.getElementById('reset-filter-btn');

    let debounceTimer;
    const submitWithDebounce = () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        fetchAndRender();
      }, 350);
    };

    if (searchInput) {
      searchInput.addEventListener('input', submitWithDebounce);
    }
    if (roleSelect) {
      roleSelect.addEventListener('change', fetchAndRender);
    }
    if (recommendationSelect) {
      recommendationSelect.addEventListener('change', fetchAndRender);
    }

    filterForm.addEventListener('submit', (event) => {
      event.preventDefault();
      fetchAndRender();
    });

    if (resetButton) {
      resetButton.addEventListener('click', () => {
        if (searchInput) searchInput.value = '';
        if (roleSelect) roleSelect.value = '';
        if (recommendationSelect) recommendationSelect.value = '';
        fetchAndRender();
      });
    }
  }

  function setupDeleteHandlers() {
    if (!tableBody) return;
    tableBody.addEventListener('click', async (event) => {
      const btn = event.target.closest('.delete-candidate-btn');
      if (!btn) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();

      const id = btn.getAttribute('data-id');
      const name = btn.getAttribute('data-name') || '';
      const confirmed = window.confirm(`Hapus hasil tes kandidat "${name}"? Tindakan ini tidak bisa dibatalkan.`);
      if (!confirmed) {
        return;
      }

      const response = await fetch(`/hr/api/candidates/${id}`, {
        method: 'DELETE',
        headers: { Accept: 'application/json' }
      });

      if (response.status === 401) {
        window.location.href = '/hr/login';
        return;
      }
      if (!response.ok) {
        window.alert('Gagal menghapus data kandidat. Silakan coba lagi.'); // eslint-disable-line no-alert
        return;
      }

      await fetchAndRender();
    });
  }

  renderRoleChart(window.roleDistribution || []);
  renderDiscChart(window.avgDisc || {});
  attachRowHandlers();
  setupLiveFilters();
  setupDeleteHandlers();
})();
