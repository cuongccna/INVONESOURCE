const { Pool } = require('pg');
require('dotenv').config({ path: 'D:/projects/INVONE/INVONESOURCE/.env' });
const fs = require('fs');
const p = new Pool({ connectionString: process.env.DATABASE_URL });
const sql = fs.readFileSync('D:/projects/INVONE/INVONESOURCE/scripts/021_line_items_manual.sql', 'utf8');
p.query(sql).then(() => { console.log('Migration 021 applied OK'); p.end(); })
  .catch(e => { console.error(e.message); p.end(); process.exit(1); });
