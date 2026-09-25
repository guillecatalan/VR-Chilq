// https-config.cjs
const fs = require('fs');
const path = require('path');

module.exports = {
    cert: fs.readFileSync(path.join(__dirname, 'ssl', 'cert.pem')),
    key: fs.readFileSync(path.join(__dirname, 'ssl', 'key.pem'))
};
