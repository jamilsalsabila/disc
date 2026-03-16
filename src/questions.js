'use strict';

const Fs = require('fs');
const Path = require('path');

const OPTION_TO_DISC = {
  A: 'D',
  B: 'I',
  C: 'S',
  D: 'C'
};

function parseQuestionsFromTxt(filePath) {
  const raw = Fs.readFileSync(filePath, 'utf-8').replace(/\r/g, '');
  const lines = raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const questions = [];
  let idx = 0;

  while (idx < lines.length) {
    const maybeNumber = lines[idx];
    if (!/^\d+$/.test(maybeNumber)) {
      idx += 1;
      continue;
    }

    const id = Number(maybeNumber);
    const options = [];
    idx += 1;

    while (idx < lines.length && options.length < 4) {
      const line = lines[idx];
      const optionMatch = /^([A-D])\.\s+(.+)$/.exec(line);
      if (!optionMatch) {
        break;
      }
      const code = optionMatch[1];
      options.push({
        code,
        text: optionMatch[2],
        disc: OPTION_TO_DISC[code]
      });
      idx += 1;
    }

    if (options.length === 4) {
      questions.push({ id, options });
    }
  }

  questions.sort((a, b) => a.id - b.id);
  return questions;
}

function loadQuestions() {
  const filePath = Path.join(process.cwd(), 'one_for_all_v1.txt');
  return parseQuestionsFromTxt(filePath);
}

module.exports = {
  OPTION_TO_DISC,
  parseQuestionsFromTxt,
  loadQuestions
};
