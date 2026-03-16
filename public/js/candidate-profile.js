(function () {
  const discData = window.discData || { D: 0, I: 0, S: 0, C: 0 };
  const roleData = window.roleScoreData || { server: 0, beverage: 0, cook: 0 };
  const isMobile = window.matchMedia('(max-width: 860px)').matches;

  const radar = document.getElementById('discRadar');
  if (radar) {
    const radarCtx = radar.getContext('2d');
    const radarGradient = radarCtx.createLinearGradient(0, 0, 0, 280);
    radarGradient.addColorStop(0, 'rgba(14, 165, 233, 0.45)');
    radarGradient.addColorStop(1, 'rgba(14, 165, 233, 0.08)');

    new Chart(radar, {
      type: 'radar',
      data: {
        labels: ['Dominance', 'Influence', 'Steadiness', 'Conscientiousness'],
        datasets: [{
          label: 'Skor DISC',
          data: [discData.D, discData.I, discData.S, discData.C],
          borderColor: '#0369A1',
          borderWidth: 2.5,
          pointRadius: isMobile ? 3 : 4,
          pointHoverRadius: isMobile ? 4 : 6,
          pointBackgroundColor: '#0284C7',
          pointBorderColor: '#F8FAFC',
          pointBorderWidth: 2,
          backgroundColor: radarGradient
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (context) => ` ${context.label}: ${context.parsed.r}`
            }
          }
        },
        scales: {
          r: {
            beginAtZero: true,
            suggestedMax: 48,
            ticks: {
              stepSize: 8,
              backdropColor: 'transparent',
              color: '#64748B'
            },
            grid: { color: '#E2E8F0' },
            angleLines: { color: '#E2E8F0' },
            pointLabels: {
              color: '#334155',
              font: {
                size: isMobile ? 11 : 12,
                weight: '600'
              }
            }
          }
        }
      }
    });
  }

  const bar = document.getElementById('roleBar');
  if (bar) {
    const barCtx = bar.getContext('2d');
    const serverGradient = barCtx.createLinearGradient(0, 0, 0, 260);
    serverGradient.addColorStop(0, '#FB923C');
    serverGradient.addColorStop(1, '#EA580C');
    const beverageGradient = barCtx.createLinearGradient(0, 0, 0, 260);
    beverageGradient.addColorStop(0, '#38BDF8');
    beverageGradient.addColorStop(1, '#0284C7');
    const cookGradient = barCtx.createLinearGradient(0, 0, 0, 260);
    cookGradient.addColorStop(0, '#2DD4BF');
    cookGradient.addColorStop(1, '#0F766E');

    new Chart(bar, {
      type: 'bar',
      data: {
        labels: ['Server', 'Beverage', 'Cook'],
        datasets: [{
          label: 'Role Fit %',
          data: [roleData.server, roleData.beverage, roleData.cook],
          backgroundColor: [serverGradient, beverageGradient, cookGradient],
          borderRadius: 12,
          maxBarThickness: isMobile ? 36 : 54
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (context) => ` ${context.parsed.y}%`
            }
          }
        },
        scales: {
          y: {
            beginAtZero: true,
            suggestedMax: 100,
            ticks: {
              callback: (value) => `${value}%`
            },
            grid: { color: '#E2E8F0' }
          },
          x: {
            grid: { display: false },
            ticks: { color: '#334155' }
          }
        }
      }
    });
  }
})();
