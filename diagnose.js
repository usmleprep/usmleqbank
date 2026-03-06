// Diagnostic script: find question files that fail to parse properly (regex-based, no JSDOM)
const fs = require('fs');
const path = require('path');

const questionsDir = path.join(__dirname, 'questions');
const files = fs.readdirSync(questionsDir).filter(f => f.endsWith('.html') && !f.includes('test') && !f.includes('backup'));

let noDetails = [];
let noChoices = [];
let fewChoices = [];
let noCorrectAnswer = [];
let badStem = [];
let goodCount = 0;
let examples = {};

for (const file of files) {
    const qid = file.replace('.html', '');
    const html = fs.readFileSync(path.join(questionsDir, file), 'utf-8');
    
    // Check for details element
    if (!/<details/i.test(html)) {
        noDetails.push(qid);
        continue;
    }
    
    // Check for choices table: look for td with letter pattern (with or without period, with or without <strong>)
    const choicePatternStd = /<td[^>]*>\s*(?:<strong>)?\s*[A-F]\.\s*(?:<\/strong>)?\s*<\/td>/i;
    const choicePatternMatrix = /<td[^>]*>\s*[A-F]\s*<\/td>/i;
    const hasChoicesTable = choicePatternStd.test(html) || choicePatternMatrix.test(html);
    
    // Count individual choices before toggle
    const toggleIdx = html.indexOf('class="toggle"');
    const searchArea = toggleIdx > 0 ? html.substring(0, toggleIdx) : html;
    const choiceMatchesStd = searchArea.match(/<td[^>]*>\s*(?:<strong>)?\s*([A-F])\.\s*(?:<\/strong>)?\s*<\/td>/gi) || [];
    const choiceMatchesMatrix = searchArea.match(/<td[^>]*>\s*([A-F])\s*<\/td>/gi) || [];
    const allChoiceMatches = [...choiceMatchesStd, ...choiceMatchesMatrix];
    
    const uniqueLetters = [...new Set(allChoiceMatches.map(m => {
        const match = m.match(/([A-F])/i);
        return match ? match[1].toUpperCase() : '';
    }).filter(Boolean))];
    
    if (!hasChoicesTable || uniqueLetters.length === 0) {
        noChoices.push(qid);
        // Save first 5 examples for inspection
        if (Object.keys(examples).length < 5) {
            // Find all tables in the file
            const tables = html.match(/<table[\s\S]*?<\/table>/gi) || [];
            examples[qid] = {
                hasTables: tables.length,
                firstTableSnippet: tables.length > 0 ? tables[0].substring(0, 500) : 'NO TABLES',
                htmlSnippet: html.substring(0, 800)
            };
        }
        continue;
    }
    
    if (uniqueLetters.length < 3) {
        fewChoices.push({ qid, count: uniqueLetters.length, letters: uniqueLetters });
    }
    
    // Check for correct answer
    const correctMatch = html.match(/Correct answer\s*([A-F])/i);
    const pctMatch = html.match(/\((\d+)%\)/);
    
    if (!correctMatch && !pctMatch) {
        noCorrectAnswer.push(qid);
    }
    
    goodCount++;
}

console.log(`\n=== DIAGNOSTIC RESULTS ===`);
console.log(`Total files: ${files.length}`);
console.log(`Good questions: ${goodCount}`);
console.log(`\n--- No <details> element (${noDetails.length}): ---`);
if (noDetails.length <= 30) console.log(noDetails.join(', '));
else console.log(noDetails.slice(0, 30).join(', ') + `... and ${noDetails.length - 30} more`);

console.log(`\n--- No choices table or 0 choices (${noChoices.length}): ---`);
if (noChoices.length <= 30) console.log(noChoices.join(', '));
else console.log(noChoices.slice(0, 30).join(', ') + `... and ${noChoices.length - 30} more`);

console.log(`\n--- Few choices (<3) (${fewChoices.length}): ---`);
fewChoices.forEach(f => console.log(`  ${f.qid}: ${f.count} choices`));

console.log(`\n--- No correct answer (${noCorrectAnswer.length}): ---`);
if (noCorrectAnswer.length <= 30) console.log(noCorrectAnswer.join(', '));
else console.log(noCorrectAnswer.slice(0, 30).join(', ') + `... and ${noCorrectAnswer.length - 30} more`);

console.log(`\n--- Bad/empty stem (${badStem.length}): ---`);
badStem.forEach(b => console.log(`  ${b.qid}: ${b.reason}`));
