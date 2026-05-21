import fs from 'fs';
const content = fs.readFileSync('src/modules/inbox/InboxPage.tsx', 'utf8');
let paren = 0, brace = 0, square = 0;
for (let i = 0; i < content.length; i++) {
  if (content[i] === '(') paren++;
  if (content[i] === ')') paren--;
  if (content[i] === '{') brace++;
  if (content[i] === '}') brace--;
  if (content[i] === '[') square++;
  if (content[i] === ']') square--;
}
console.log({ paren, brace, square });
