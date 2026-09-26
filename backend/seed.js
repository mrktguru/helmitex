const { PrismaClient } = require('@prisma/client');
const argon2 = require('argon2');
require('dotenv').config();
const password = process.env.SEED_ADMIN_PASSWORD;
if (!password) { console.error('SEED_ADMIN_PASSWORD is required'); process.exit(1); }
const prisma = new PrismaClient();
argon2.hash(password).then(function(hash) {
  return prisma.user.upsert({
    where: { email: 'admin@labelstudio.local' },
    update: {},
    create: { email: 'admin@labelstudio.local', passwordHash: hash, role: 'ADMIN' }
  });
}).then(function(u) {
  console.log('Admin created:', u.email);
  return prisma.$disconnect();
}).catch(function(e) { console.error(e); process.exit(1); });
