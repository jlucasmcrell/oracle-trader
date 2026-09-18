import fs from 'node:fs'

const path = 'src/main/strategies/cryptoConvergence.ts'
let text = fs.readFileSync(path, 'utf8')

// Replace literal "\n" sequences with real newlines
text = text.replace(/\\n/g, '\n')

fs.writeFileSync(path, text)
console.log('cryptoConvergence.ts cleaned up')
