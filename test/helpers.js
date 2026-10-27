'use strict';
const fs = require('fs');
const path = require('path');
const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
module.exports = { fixture, sleep };
