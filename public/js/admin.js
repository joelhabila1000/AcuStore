(function () {
  'use strict';

  document.querySelectorAll('[data-sidebar-toggle]').forEach(function (button) {
    var sidebar = document.querySelector('[data-sidebar]');
    if (!sidebar) return;
    button.addEventListener('click', function () {
      var open = sidebar.classList.toggle('is-open');
      button.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  });

  document.querySelectorAll('form[data-confirm]').forEach(function (form) {
    form.addEventListener('submit', function (event) {
      var message = form.getAttribute('data-confirm') || 'Are you sure?';
      if (!window.confirm(message)) event.preventDefault();
    });
  });

  document.querySelectorAll('[data-image-input]').forEach(function (input) {
    var preview = document.querySelector('[data-image-preview]');
    if (!preview) return;
    input.addEventListener('change', function () {
      var file = input.files && input.files[0];
      if (!file) return;
      preview.src = URL.createObjectURL(file);
      preview.hidden = false;
    });
  });

  var source = document.querySelector('[data-slug-source]');
  var target = document.querySelector('[data-slug-target]');
  if (source && target) {
    var manual = target.value.trim().length > 0;
    target.addEventListener('input', function () {
      manual = true;
    });
    source.addEventListener('input', function () {
      if (manual) return;
      target.value = source.value
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    });
  }
})();
