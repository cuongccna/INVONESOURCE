const fs = require('fs');
const f = 'd:/projects/INVONE/INVONESOURCE/backend/src/jobs/SyncWorker.ts';
let c = fs.readFileSync(f, 'utf8');

// Fix 1: auth error createNotification -> notificationService.onConnectorError
c = c.replace(
  /await createNotification\(\s*[\r\n]+\s*companyId,\s*[\r\n]+\s*'CONNECTOR_ERROR',\s*[\r\n]+\s*`[^`]+`,\s*[\r\n]+\s*`[^`]+`\s*[\r\n]+\s*\);\s*[\r\n]+\s*return \{ recordsFetched: 0, errors \};/,
  "await notificationService.onConnectorError(companyId, plugin.id);\r\n      return { recordsFetched: 0, errors };"
);

// Fix 2: circuit opened path
c = c.replace(
  /\/\/ Trigger notification when circuit opens\s*[\r\n]+\s*await createNotification\(\s*[\r\n]+\s*companyId,\s*[\r\n]+\s*'CONNECTOR_ERROR',[\s\S]*?\);\s*[\r\n]+\s*\}/,
  "await notificationService.onConnectorError(companyId, plugin.id);\r\n    }"
);

// Fix 3: remove the local createNotification function definition
c = c.replace(
  /[\r\n]+async function createNotification\([\s\S]+?\}\s*catch \(err\) \{\s*[\r\n]+\s*console\.error\('[^']+', err\);\s*[\r\n]+\s*\}\s*[\r\n]+\}/,
  ''
);

const remaining = (c.match(/\bcreateNotification\b/g) || []).length;
const svcCount = (c.match(/notificationService/g) || []).length;
console.log('Remaining createNotification:', remaining);
console.log('notificationService calls:', svcCount);

if (remaining > 0) {
  // Show context around remaining occurrences
  let idx = 0;
  while ((idx = c.indexOf('createNotification', idx)) !== -1) {
    console.log('At char', idx, ':', JSON.stringify(c.substring(idx, idx + 120)));
    idx++;
  }
}

fs.writeFileSync(f, c, 'utf8');
console.log('Written.');
