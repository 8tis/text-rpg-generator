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
const line593 = lines[592]; // 0-indexed is 592 for line 593

console.log(`Line 593 text: [${line593}]`);
for (let i = 0; i < line593.length; i++) {
    console.log(`Char ${i}: ${line593[i]} (code: ${line593.charCodeAt(i)})`);
}
