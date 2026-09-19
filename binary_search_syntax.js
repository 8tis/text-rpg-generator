const fs = require('fs');
const vm = require('vm');

const html = fs.readFileSync('public/index.html', 'utf8');

// Find the massive script tag that doesn't have a "src" attribute
const scriptMatches = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)];
let jsCode = '';
for (const match of scriptMatches) {
    if (match[1].length > 10000) {
        jsCode = match[1];
        break;
    }
}

// Strip import statements
let cleanedJs = jsCode.replace(/^\s*import\b[\s\S]*?;/gm, '');

const jsLines = cleanedJs.split('\n');

// Find lines containing the duplicate block and remove them
let foundIndex = -1;
for (let i = 0; i < jsLines.length - 5; i++) {
    if (jsLines[i].trim() === '}' &&
        jsLines[i+1].trim() === '' &&
        jsLines[i+2].includes('processLootBagSurvivalItems') &&
        jsLines[i+3].includes('updateExplorationUI') &&
        jsLines[i+4].trim() === '}') {
        foundIndex = i;
        break;
    }
}
if (foundIndex !== -1) {
    jsLines.splice(foundIndex + 1, 4);
}

// Binary search syntax errors by compiling prefixes of the script
let low = 1;
let high = jsLines.length;
let lastValid = 0;

console.log(`Total lines: ${high}`);

while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const prefix = jsLines.slice(0, mid).join('\n');
    
    // To make a prefix syntactically valid (closing braces, etc.),
    // compiling a prefix might fail due to unclosed functions, but we can catch basic syntax errors
    // or we can analyze where the unclosed quotes or brackets are.
    // Let's see if we can compile it:
    try {
        new vm.Script(prefix);
        // Prefix compiled successfully or has block-end mismatch (which compiles but won't run,
        // unless it's a structural syntax error like unclosed string/comment).
        lastValid = mid;
        low = mid + 1;
    } catch (err) {
        // If it fails with "unexpected token" or "invalid token", we can check if it's because of our prefix chop,
        // or a real syntax error. Let's see the error message.
        if (err.message.includes('Unexpected end of input') || err.message.includes('missing }')) {
            // These are expected when we chop off in the middle of a block.
            // So we treat this prefix as potentially valid (the syntax error might be further down or before).
            lastValid = mid;
            low = mid + 1;
        } else {
            // This is a hard syntax error (like unclosed string literal, invalid token, etc.)
            high = mid - 1;
        }
    }
}

console.log(`Binary search finished. First syntax-error-introducing line is around line: ${high + 1}`);
console.log("Lines around:", (high + 1));
for (let i = Math.max(0, high - 5); i < Math.min(jsLines.length, high + 5); i++) {
    console.log(`${i + 1}: ${jsLines[i]}`);
}
