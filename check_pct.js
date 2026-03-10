const fs = require('fs');
const files = fs.readdirSync('questions').filter(f => f.endsWith('.html') && !f.includes('backup') && !f.includes('test'));

let noPct = 0, hasPct = 0, mismatch = 0, noCorrectText = 0;
let mismatchExamples = [];
let noPctExamples = [];

for (const file of files) {
  try {
    const html = fs.readFileSync('questions/' + file, 'utf8');
    
    // Find the Submit section
    const submitIdx = html.indexOf('<summary>Submit</summary>');
    if (submitIdx === -1) { noPct++; if (noPctExamples.length < 5) noPctExamples.push(file + ' (no Submit)'); continue; }
    const submitSection = html.substring(submitIdx);
    
    // Find all percentage patterns: letter + percentage in the submit table rows
    // Pattern: <td...>A.</td> ... (XX%) or just letter without period
    let choicePercentages = {};
    const rowRe = /<tr[^>]*>[\s\S]*?<td[^>]*>\s*([A-F])\.?\s*<\/td>[\s\S]*?<td[^>]*>([\s\S]*?)<\/td>/gi;
    let m;
    while ((m = rowRe.exec(submitSection)) !== null) {
      const letter = m[1];
      const cellContent = m[2];
      const pctMatch = cellContent.match(/\((\d+)%\)/);
      if (pctMatch) choicePercentages[letter] = parseInt(pctMatch[1]);
    }
    
    // Find correct answer text
    let correctFromText = '';
    const correctMatch = submitSection.match(/Correct answer\s*([A-F])/i);
    if (correctMatch) correctFromText = correctMatch[1];
    
    // Find max pct
    let maxLetter = '', maxPct = -1;
    for (const [l, p] of Object.entries(choicePercentages)) {
      if (p > maxPct) { maxPct = p; maxLetter = l; }
    }
    
    if (Object.keys(choicePercentages).length > 0) {
      hasPct++;
      if (correctFromText && maxLetter !== correctFromText) {
        mismatch++;
        if (mismatchExamples.length < 15) {
          mismatchExamples.push({ file, correctFromText, maxLetter, maxPct, pcts: choicePercentages });
        }
      }
      if (!correctFromText) noCorrectText++;
    } else {
      noPct++;
      if (noPctExamples.length < 10) noPctExamples.push(file);
    }
  } catch(e) {
    // skip
  }
}

console.log('Total files:', files.length);
console.log('Has percentages:', hasPct);
console.log('No percentages:', noPct);
console.log('Mismatch (text answer != max %):', mismatch);
console.log('No correct text at all:', noCorrectText);
console.log('\nNo-pct examples:', noPctExamples);
console.log('\nMismatch examples:', JSON.stringify(mismatchExamples, null, 2));
