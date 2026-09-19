const fs = require('fs');

const html = fs.readFileSync('public/index.html', 'utf8');

const scriptMatches = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)];
let jsCode = '';
for (const match of scriptMatches) {
    if (match[1].length > 10000) {
        jsCode = match[1];
        break;
    }
}

const lines = jsCode.split('\n');

console.log("Lines 575 to 595 of original inline JS:");
for (let i = 570; i < 600; i++) {
    console.log(`${i + 1}: ${lines[i]}`);
}
