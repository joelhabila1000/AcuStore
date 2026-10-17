(function () {
  'use strict';

  document.querySelectorAll('[data-qty]').forEach(function (group) {
    var input = group.querySelector('.qty-input');
    if (!input) return;
    group.querySelectorAll('[data-qty-step]').forEach(function (button) {
      button.addEventListener('click', function () {
        var step = parseInt(button.getAttribute('data-qty-step'), 10) || 0;
        var min = parseInt(input.getAttribute('min'), 10);
        var max = parseInt(input.getAttribute('max'), 10);
        if (!Number.isFinite(min)) min = 1;
        if (!Number.isFinite(max)) max = 99;
        var next = (parseInt(input.value, 10) || min) + step;
        input.value = Math.min(Math.max(next, min), max);
      });
    });
  });

  document.querySelectorAll('[data-auto-submit]').forEach(function (select) {
    select.addEventListener('change', function () {
      if (select.form) select.form.submit();
    });
  });

  var toast = document.querySelector('[data-toast]');
  var toastTimer;
  function showToast(message, isError) {
    if (!toast) return;
    toast.textContent = message;
    toast.classList.toggle('is-error', Boolean(isError));
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toast.hidden = true;
    }, 3000);
  }

  document.querySelectorAll('form[data-ajax-form]').forEach(function (form) {
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var button = form.querySelector('button[type="submit"]');
      if (button) button.disabled = true;

      var data = new URLSearchParams(new FormData(form));

      fetch(form.action, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'X-CSRF-Token': data.get('_csrf') || ''
        },
        body: data
      })
        .then(function (response) {
          return response.json().then(function (body) {
            return { ok: response.ok, body: body };
          });
        })
        .then(function (result) {
          if (!result.ok || !result.body.ok) {
            throw new Error((result.body && result.body.error) || 'Could not add that to your cart.');
          }
          document.querySelectorAll('[data-cart-count]').forEach(function (el) {
            el.textContent = result.body.count;
          });
          showToast('Added to cart');
        })
        .catch(function (error) {
          showToast(error.message || 'Something went wrong.', true);
        })
        .finally(function () {
          if (button) button.disabled = false;
        });
    });
  });
})();
