'use strict';

const Bcrypt = require('bcryptjs');

const plain = process.argv[2];
if (!plain || plain.length < 8) {
  // eslint-disable-next-line no-console
  console.error('Usage: node scripts/hash-password.js "YourStrongPassword"');
  process.exit(1);
}

const hash = Bcrypt.hashSync(plain, 12);
// eslint-disable-next-line no-console
console.log(hash);
