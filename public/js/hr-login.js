(function () {
  const input = document.getElementById('hr-password');
  const toggle = document.getElementById('password-toggle');

  if (!input || !toggle) {
    return;
  }

  toggle.addEventListener('click', () => {
    const isHidden = input.type === 'password';
    input.type = isHidden ? 'text' : 'password';
    toggle.classList.toggle('is-visible', isHidden);
    toggle.setAttribute('aria-pressed', isHidden ? 'true' : 'false');
    toggle.setAttribute('aria-label', isHidden ? 'Sembunyikan password' : 'Tampilkan password');
  });
})();
