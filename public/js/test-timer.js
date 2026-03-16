(function () {
  const container = document.querySelector('.test-page');
  const countdownEl = document.getElementById('countdown');
  const form = document.getElementById('disc-form');

  if (!container || !countdownEl || !form) {
    return;
  }

  const deadline = new Date(container.dataset.deadline).getTime();
  const radios = Array.from(form.querySelectorAll('input[type="radio"]'));
  const progressEl = document.getElementById('valid-progress');
  let hasAutoSubmitted = false;

  const questionIds = Array.from(
    new Set(
      radios.map((radio) => {
        const m = /q_(\d+)_(most|least)/.exec(radio.name);
        return m ? m[1] : null;
      }).filter(Boolean)
    )
  );

  function pad(value) {
    return String(value).padStart(2, '0');
  }

  function tick() {
    const now = Date.now();
    const diffMs = deadline - now;

    if (diffMs <= 0) {
      countdownEl.textContent = '00:00';
      if (!hasAutoSubmitted) {
        hasAutoSubmitted = true;
        form.submit();
      }
      return;
    }

    const totalSec = Math.floor(diffMs / 1000);
    const mins = Math.floor(totalSec / 60);
    const secs = totalSec % 60;
    countdownEl.textContent = `${pad(mins)}:${pad(secs)}`;

    const floatingTimer = document.querySelector('.floating-timer');
    if (floatingTimer) {
      if (totalSec <= 120) {
        floatingTimer.classList.add('is-warning');
      } else {
        floatingTimer.classList.remove('is-warning');
      }
    }
  }

  tick();
  setInterval(tick, 1000);

  function getQuestionState(qid) {
    const most = form.querySelector(`input[name="q_${qid}_most"]:checked`);
    const least = form.querySelector(`input[name="q_${qid}_least"]:checked`);
    return {
      most,
      least,
      isValid: Boolean(most && least && most.value !== least.value)
    };
  }

  function updateQuestionBadge(qid) {
    const badge = form.querySelector(`.question-status[data-question-id="${qid}"]`);
    if (!badge) {
      return;
    }
    const state = getQuestionState(qid);
    badge.textContent = state.isValid ? 'Valid' : 'Belum valid';
    badge.classList.toggle('is-valid', state.isValid);
    badge.classList.toggle('is-invalid', !state.isValid);
  }

  function updateProgress() {
    let validCount = 0;
    questionIds.forEach((qid) => {
      const state = getQuestionState(qid);
      if (state.isValid) {
        validCount += 1;
      }
      updateQuestionBadge(qid);
    });
    if (progressEl) {
      progressEl.textContent = `${validCount} / ${questionIds.length} nomor`;
    }
  }

  radios.forEach((radio) => {
    radio.addEventListener('change', () => {
      const match = /q_(\d+)_(most|least)/.exec(radio.name);
      if (!match) return;
      const qid = match[1];
      const type = match[2];
      const oppositeType = type === 'most' ? 'least' : 'most';
      const oppositeChecked = form.querySelector(`input[name="q_${qid}_${oppositeType}"]:checked`);
      if (oppositeChecked && oppositeChecked.value === radio.value) {
        oppositeChecked.checked = false;
      }
      updateProgress();
    });
  });

  updateProgress();

  form.addEventListener('submit', (event) => {
    for (const qid of questionIds) {
      const state = getQuestionState(qid);
      if (!state.isValid) {
        event.preventDefault();
        alert('Setiap nomor wajib memilih 1 Most dan 1 Least yang berbeda.'); // eslint-disable-line no-alert
        updateProgress();
        return;
      }
    }
  });
})();
