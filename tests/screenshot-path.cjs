// Test screenshots go in tests/screenshots/ (ignored by git), never the app's own folder.
const fs = require('node:fs');
const path = require('node:path');
const dir = path.join(__dirname, 'screenshots');
module.exports = name => {
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, name);
};
