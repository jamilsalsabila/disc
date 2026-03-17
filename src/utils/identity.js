'use strict';

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function normalizeWhatsapp(whatsapp) {
  return String(whatsapp || '').replace(/\D/g, '');
}

module.exports = {
  normalizeEmail,
  normalizeWhatsapp
};
